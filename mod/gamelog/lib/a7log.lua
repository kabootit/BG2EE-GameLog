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
	A7LOG_trimmed = 0 -- rows the engine has removed off the front of combatLog
	A7LOG_emitted = 0 -- absolute id of the last row we exported

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

local function A7LOG_checkRoster()
	if type(characters) ~= "table" then
		return
	end

	local names = {}
	-- Scanned rather than indexed 1..6: party slot numbering is not guaranteed,
	-- and a missing slot must not stop the ones after it being seen.
	for i = 0, 9 do
		local c = characters[i]
		if type(c) == "table" and type(c.name) == "string" and c.name ~= "" then
			names[#names + 1] = c.name
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

local function A7LOG_drain()
	local total = A7LOG_trimmed + #combatLog

	-- Rows can be trimmed before we ever see them (e.g. a burst between frames).
	-- Skip past them rather than emitting stale text under fresh ids.
	if A7LOG_emitted < A7LOG_trimmed then
		A7LOG_emitted = A7LOG_trimmed
	end

	-- Only look at the roster when the log actually moved. Keeps the per-frame
	-- cost at one comparison, and anything that changes the party (a join, a
	-- death) writes to the log anyway.
	if A7LOG_emitted < total then
		A7LOG_checkRoster()
	end

	while A7LOG_emitted < total do
		A7LOG_emitted = A7LOG_emitted + 1
		local row = combatLog[A7LOG_emitted - A7LOG_trimmed]
		if row ~= nil then
			Infinity_Log(string.format(
				"A7LOG\t%d\t%s\t%s\t%s\t%s\t%s",
				A7LOG_emitted,
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
