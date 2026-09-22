-- BG2EE-GameLog tap.
--
-- Installed to override/a7log.lua and pulled in from ui.menu with
-- Infinity_DoFile("a7log") right after `combatLog = {}` is declared.
--
-- The engine keeps the message window's contents in the global Lua table
-- `combatLog`: it appends rows from C++ and trims the oldest ones by running
-- `table.remove(combatLog, n)`. Wrapping table.remove lets us count the trims,
-- which turns the shifting array position into a stable monotonic row id.
--
-- Every new row is written to the process's stdout via Infinity_Log as one
-- tab-separated line:
--
--   A7LOG <id> <gameTicks> <clockMs> <gameTime> <screen> <text>

if not A7LOG_installed then
	A7LOG_installed = true
	-- Session-monotonic row id. Never reset: storage is keyed on (session, id),
	-- so restarting the count would overwrite rows captured earlier.
	A7LOG_seq = 0
	-- State for the combatLog table currently being tracked. Reset whenever the
	-- engine swaps that table out - see A7LOG_drain.
	A7LOG_table = nil -- identity of the table these counters describe
	A7LOG_trimmed = 0 -- rows the engine has removed off the front of it
	A7LOG_seen = 0 -- rows of it we have already exported

	local _remove = table.remove
	-- Forward the varargs untouched. Turning table.remove(t) into
	-- table.remove(t, nil) would break every single-argument call in the UI.
	table.remove = function(t, ...)
		if t == combatLog then
			A7LOG_trimmed = A7LOG_trimmed + 1
		end
		return _remove(t, ...)
	end
end

-- Call an engine function that may not exist on every build/version.
-- Never let a missing accessor stop the export.
local function A7LOG_safe(fn)
	if type(fn) ~= "function" then
		return ""
	end
	local ok, value = pcall(fn)
	if not ok or value == nil then
		return ""
	end
	return tostring(value)
end

-- Party roster, emitted only when it changes.
--
-- `characters` is an engine-populated Lua table, the same arrangement as
-- combatLog, so reading it needs no Infinity_* accessor. That matters: this
-- code can run before a game exists, where an engine accessor would dereference
-- a null game pointer and segfault the process.
local A7LOG_roster = ""
-- Last saving-throw text seen per character, so a line is emitted only when it
-- actually changes rather than on every poll.
local A7LOG_saves = {}

-- What `characters` looked like last time we said so, to report a change once
-- rather than every frame.
local A7LOG_charState = ""

-- Report what `characters` actually is, whenever that changes.
--
-- Diagnostic, and it earns its place: A7ROSTER has emitted **zero** lines in
-- every session ever captured, so the roster tap has never worked and
-- SideResolver has been silently running on its speech fallback the whole time.
-- The cause cannot be an exception - this runs inside the drain's pcall, before
-- the loop that emits rows, so a throw here would have stopped those too and
-- there are 86k of them. That leaves the early return, i.e. `characters` is not
-- a table when the tap reads it.
--
-- Separate marker so it cannot be mistaken for an event: parseLine only accepts
-- A7LOG.
local function A7LOG_probeCharacters()
	local state
	if type(characters) ~= "table" then
		state = type(characters)
	else
		local keys, named, sample = 0, 0, {}
		for k, v in pairs(characters) do
			keys = keys + 1
			if #sample < 8 then
				sample[#sample + 1] = tostring(k) .. ":" .. type(v)
			end
			if type(v) == "table" and type(v.name) == "string" and v.name ~= "" then
				named = named + 1
			end
		end
		-- The keys themselves are the point: if they are not 0..9 that alone
		-- explains why the old roster scan never found anything.
		state = string.format(
			"table keys=%d named=%d [%s]",
			keys, named, table.concat(sample, " ")
		)
	end

	if state ~= A7LOG_charState then
		A7LOG_charState = state
		Infinity_Log("A7PROBE\tcharacters " .. state)
	end
end

local function A7LOG_checkRoster()
	A7LOG_probeCharacters()

	if type(characters) ~= "table" then
		return
	end

	local names = {}
	-- Enumerated with pairs() rather than scanned over 0..9.
	--
	-- The old loop assumed small integer keys and its own comment conceded that
	-- "party slot numbering is not guaranteed" — and the roster has emitted
	-- nothing in any session ever recorded, so that assumption is a prime
	-- suspect. pairs() makes no assumption about the key space at all. The
	-- guard below is what keeps non-character entries out, and it was already
	-- doing that job.
	for _, c in pairs(characters) do
		if type(c) == "table" and type(c.name) == "string" and c.name ~= "" then
			names[#names + 1] = c.name

			-- Saving throws, which the combat log itself never gives a verdict
			-- on. The record screen reads them from here: override/ui.menu
			-- builds its SAVING_THROWS_LABEL row from
			-- characters[id].proficiencies.savingThrows and concatenates it
			-- straight into display text.
			--
			-- So this is already formatted and localized by the engine, not five
			-- numbers. It ships as-is and is taken apart capture-side; tabs and
			-- newlines are flattened first so one character stays one row.
			--
			-- Reading it is as safe as the roster scan: a plain Lua table, no
			-- Infinity_* accessor, so nothing here can dereference a null game
			-- pointer before a game exists.
			local prof = c.proficiencies
			if type(prof) == "table" and type(prof.savingThrows) == "string" then
				local throws = prof.savingThrows:gsub("[\r\n]+", " | "):gsub("\t", " ")
				if A7LOG_saves[c.name] ~= throws then
					A7LOG_saves[c.name] = throws
					Infinity_Log("A7STATS\t" .. c.name .. "\t" .. throws)
				end
			end
		end
	end

	if #names == 0 then
		return
	end

	local line = table.concat(names, "\t")
	if line ~= A7LOG_roster then
		A7LOG_roster = line
		Infinity_Log("A7ROSTER\t" .. line)
	end
end

-- Emit a synthetic row in the normal event stream. Used to mark a capture reset,
-- so a dropped block is visible in the data instead of having to be inferred
-- from missing xp and creatures that appear without ever being summoned.
local function A7LOG_note(text)
	A7LOG_seq = A7LOG_seq + 1
	Infinity_Log(string.format(
		"A7LOG\t%d\t%s\t%s\t%s\t%s\t%s",
		A7LOG_seq,
		A7LOG_safe(Infinity_GetGameTicks),
		A7LOG_safe(Infinity_GetClockTicks),
		A7LOG_safe(Infinity_GetTimeString),
		A7LOG_safe(Infinity_GetCurrentScreenName),
		text
	))
end

local function A7LOG_drain()
	-- Loading a save re-runs ui.menu, which rebinds `combatLog` to a brand new
	-- empty table. The install guard above deliberately does not re-run, so
	-- without this the counters stay high while the new table starts from zero,
	-- `A7LOG_seen < total` is never true again, and the tap goes silent for the
	-- rest of the session. Compare table identity, not contents.
	if A7LOG_table ~= combatLog then
		local first = A7LOG_table == nil
		A7LOG_table = combatLog
		A7LOG_trimmed = 0
		A7LOG_seen = 0
		-- Not on the very first bind, which is not a reset.
		if not first then
			A7LOG_note("capture resynced: combatLog was replaced (rows before this may be missing)")
		end
	end

	local total = A7LOG_trimmed + #combatLog

	-- Same failure by another route: the table stayed the same object but was
	-- emptied in a way our table.remove wrapper did not observe.
	if total < A7LOG_seen then
		A7LOG_trimmed = 0
		A7LOG_seen = 0
		total = #combatLog
		A7LOG_note("capture resynced: combatLog was cleared (rows before this may be missing)")
	end

	-- Rows can be trimmed before we ever see them (e.g. a burst between frames).
	-- Skip past them rather than emitting stale text under fresh ids.
	if A7LOG_seen < A7LOG_trimmed then
		A7LOG_seen = A7LOG_trimmed
	end

	-- Only look at the roster when the log actually moved. Keeps the per-frame
	-- cost at one comparison, and anything that changes the party (a join, a
	-- death) writes to the log anyway.
	if A7LOG_seen < total then
		A7LOG_checkRoster()
	end

	while A7LOG_seen < total do
		A7LOG_seen = A7LOG_seen + 1
		local row = combatLog[A7LOG_seen - A7LOG_trimmed]
		if row ~= nil then
			A7LOG_seq = A7LOG_seq + 1
			Infinity_Log(string.format(
				"A7LOG\t%d\t%s\t%s\t%s\t%s\t%s",
				A7LOG_seq,
				A7LOG_safe(Infinity_GetGameTicks),
				A7LOG_safe(Infinity_GetClockTicks),
				A7LOG_safe(Infinity_GetTimeString),
				A7LOG_safe(Infinity_GetCurrentScreenName),
				(tostring(row):gsub("[\r\n\t]", " "))
			))
		end
	end
end

-- Called once per frame from hidden labels in LEFT_SIDEBAR and WORLD_MESSAGES.
-- Idempotent, so being called more than once per frame is harmless.
-- The pcall matters: this runs inside the render path, and an uncaught Lua error
-- in a `text lua` expression disrupts the HUD.
function A7LOG_tick()
	pcall(A7LOG_drain)
	return ""
end

-- Emit one line at load time. This is what tells "the transport works, nothing
-- has happened yet" apart from "Infinity_Log never reaches stdout". Id 0 is
-- outside the combatLog id space, and re-emitting it on a UI reload just
-- replaces the row.
--
-- Deliberately no engine accessors here. This chunk runs while ui.menu is being
-- loaded, before any game exists, and calling something like
-- Infinity_GetGameTicks() at that point dereferences a null game pointer and
-- segfaults the process - a C++ crash that pcall cannot catch.
Infinity_Log("A7LOG\t0\t\t\t\t\tgamelog tap loaded")
