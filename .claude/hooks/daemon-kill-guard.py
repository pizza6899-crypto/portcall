#!/usr/bin/env python3
"""PreToolUse(Bash) guard: refuse a kill that would hit a launchd-managed process.

`pkill -f 'dist/src/server.js.*'` was meant for a throwaway test instance and
also matched the portcall daemon serving real traffic. Twice in one session
(2026-09-20). KeepAlive restarted it both times, so the damage was ~10s of
downtime — plus the guard's in-memory block state, which a restart clears.

The rule this enforces: know which process you are killing. A pattern is a
guess about the process table; a PID is not. So a kill is allowed only once
it has been established that nothing launchd owns is in range.

Blocks
  - pkill/killall whose pattern currently matches a launchd-managed PID
  - pkill/killall this cannot parse confidently (fail closed)
  - kill <pid> where that PID is launchd-managed
  - kill $(...) / `...`, where the target cannot be seen before it is sent

Allows
  - pkill/killall matching only ordinary processes (a test instance, a stray tsx)
  - kill <pid> for a PID launchd does not own

Exit 2 + stderr = block, message fed back to the model.
"""
import json
import re
import subprocess
import sys


WRAPPERS = {"sudo", "env", "command", "xargs", "time", "nohup"}


def bail(message: str) -> None:
    sys.stderr.write(f"BLOCKED by daemon-kill-guard: {message}\n")
    sys.exit(2)


def launchd_pids() -> dict[str, str]:
    """PID → label for everything launchd currently has running."""
    try:
        out = subprocess.run(["launchctl", "list"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return {}
    owned = {}
    for line in out.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) >= 3 and parts[0].strip().isdigit():
            owned[parts[0].strip()] = parts[2].strip()
    return owned


def pgrep(args: list[str]) -> set[str]:
    try:
        out = subprocess.run(["pgrep", *args], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return set()
    return {line.strip() for line in out.splitlines() if line.strip().isdigit()}


def describe(hits: dict[str, str]) -> str:
    return ", ".join(f"{pid} ({label})" for pid, label in sorted(hits.items()))


try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # malformed input — never block on our own failure

command = data.get("tool_input", {}).get("command", "")
if not re.search(r"\b(pkill|killall|kill)\b", command):
    sys.exit(0)

owned = launchd_pids()

for segment in re.split(r"\|\||&&|[|;\n]", command):
    tokens = segment.strip().split()
    if not tokens:
        continue

    # Skip wrappers so `sudo pkill`, `FOO=1 pkill` and `xargs kill` are still seen.
    start = 0
    piped_in = False
    while start < len(tokens) and ("=" in tokens[start] or tokens[start] in WRAPPERS):
        if tokens[start] == "xargs":
            piped_in = True
        start += 1
    if start >= len(tokens):
        continue

    name = tokens[start].rsplit("/", 1)[-1]
    args = tokens[start + 1 :]
    if name not in {"pkill", "killall", "kill"}:
        continue

    if name in {"pkill", "killall"}:
        flags = [a for a in args if a.startswith("-")]
        operands = [a for a in args if not a.startswith("-")]

        # Anything that narrows or widens the match in a way not modelled here
        # (-u, -P, -G, -t …) is not worth guessing at.
        understood = {"-f", "-x", "-i", "-9", "-15", "-TERM", "-KILL", "-INT", "-HUP", "-l", "-signal"}
        if len(operands) != 1 or any(flag not in understood for flag in flags):
            bail(
                f"`{name}` here is not something this guard can check ({segment.strip()}). "
                "Resolve the PIDs first (`pgrep -fl <pattern>`), look at what came back, "
                "then kill those PIDs explicitly."
            )

        pattern = operands[0].strip("'\"")
        # Without -f both pkill and killall match the executable name exactly,
        # which is what `pgrep -x` does.
        lookup = ["-f", pattern] if "-f" in flags else ["-x", pattern]

        hits = {pid: owned[pid] for pid in pgrep(lookup) if pid in owned}
        if hits:
            bail(
                f"`{segment.strip()}` currently matches a launchd-managed process: {describe(hits)}. "
                "launchd will restart it, so this looks harmless and is not: a restart drops live "
                "connections and clears in-memory state. Kill the PID you actually mean instead — "
                f"`pgrep -fl {pattern}` shows every match."
            )
        continue

    # plain `kill`
    if args == ["-l"] or "-l" in args:
        continue  # listing signal names kills nothing

    literal = [a for a in args if a.isdigit()]
    if piped_in or any(marker in segment for marker in ("$(", "`")) or not literal:
        bail(
            f"`{segment.strip()}` decides what to kill while it runs, so there is nothing to check "
            "beforehand. Print the PIDs first (`pgrep -fl …` or `lsof -ti tcp:PORT`), look at what "
            "came back, then kill them by number."
        )
    hits = {pid: owned[pid] for pid in literal if pid in owned}
    if hits:
        bail(f"PID {describe(hits)} is managed by launchd. Stop it with `launchctl` if that is the intent.")

sys.exit(0)
