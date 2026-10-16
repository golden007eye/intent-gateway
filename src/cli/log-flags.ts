// `intent log` options: filters (--since, --action, --last), the output mode (--verbose, --json, --follow) and the
// style (colour only on a terminal without NO_COLOR or --no-color; --utc).
import { ACTION_KINDS, type ActionKind } from "../activity/index.ts";
import { INTENT } from "../config/index.ts";
import { CliError, type Io } from "./io.ts";
import type { LogFlags } from "./log.ts";

type Values = Record<string, string | boolean | undefined>;

const UNITS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function logFlags(io: Io, values: Values): LogFlags {
  const str = (name: string): string | undefined => (typeof values[name] === "string" ? values[name] : undefined);
  const utc = values.utc === true;
  const now = (io.now ?? Date.now)();
  const since = str("since");
  const action = str("action");
  const last = str("last");
  const noColor = values["no-color"] === true || (io.env.NO_COLOR ?? "") !== "" || io.env.TERM === "dumb";
  return {
    verbose: values.verbose === true,
    json: values.json === true,
    follow: values.follow === true,
    filter: {
      ...(since === undefined ? {} : { since: parseSince(since, now, utc) }),
      ...(action === undefined ? {} : { actions: parseActions(action) }),
      ...(last === undefined ? {} : { last: parseLast(last) }),
    },
    style: { color: io.isTTY.stdout && !noColor, utc },
  };
}

/** `30m`, `2h`, `7d`, `1w` before now; or a date (`2026-10-16`, local midnight, UTC with --utc) or a time with its zone. */
export function parseSince(text: string, now: number, utc: boolean): Date {
  const duration = /^([0-9]+)([smhdw])$/.exec(text);
  if (duration !== null) return new Date(now - Number(duration[1]) * (UNITS[duration[2] ?? ""] ?? 0));
  const day = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text);
  const at = day === null ? Date.parse(text) : utc ? Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
  if (!/^[0-9]{4}-/.test(text) || Number.isNaN(at)) {
    throw new CliError(`--since takes a duration (30m, 2h, 7d) or a date (2026-10-16 or 2026-10-16T09:00:00Z), not "${text}"; run ${INTENT} --help`, 2);
  }
  return new Date(at);
}

/** `search,cart`: one or more action kinds. */
export function parseActions(text: string): ReadonlySet<ActionKind> {
  const kinds = text.split(",").map((k) => k.trim());
  const unknown = kinds.filter((k) => !(ACTION_KINDS as readonly string[]).includes(k));
  if (unknown.length > 0 || kinds.length === 0) {
    throw new CliError(`--action takes one or more of ${ACTION_KINDS.filter((k) => k !== "unreadable").join(", ")} (comma-separated), not "${unknown.join(",")}"; run ${INTENT} --help`, 2);
  }
  return new Set(kinds as ActionKind[]);
}

function parseLast(text: string): number {
  if (!/^[1-9][0-9]*$/.test(text)) throw new CliError(`--last takes a whole number of actions (1 or more), not "${text}"; run ${INTENT} --help`, 2);
  return Number(text);
}
