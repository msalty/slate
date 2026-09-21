/**
 * Naming an event, and saying when it is.
 *
 * This began as one field. The reasoning was that the day is answered by the
 * calendar you are looking at and the time by the clock — and the first half of
 * that is true while the second is not. An event is, almost by definition, at a
 * time that is not now: "the next round half hour" is the right guess for a
 * thing you are starting *this minute*, which a daily note or a captured task
 * is and a meeting never is. So every event was made and then immediately
 * edited, and the one field was one field plus a second trip.
 *
 * The times are therefore on the dialog, filled in with the same guesses the
 * one-field version used. Nothing is slower for it: Enter in the name still
 * makes the event and closes, so the fields are there for when the guess is
 * wrong rather than in the way when it is right.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import {
  defaultEventTimes,
  eventFolderFor,
  instantOf,
  keepDuration,
  knownZones,
  newEventNote,
  templateZoneFor,
  wallPlusHour,
} from "../core/eventnote";
import { isKnownZone } from "../core/markdown";
import { notify, openNote } from "./state";
import { IconClose } from "./Icons";

const open = signal<{ day: number } | null>(null);

export function openNewEventDialog(day: number) {
  open.value = { day };
}

/** The date half of a `datetime-local` value, which is a whole day on its own. */
const dateOf = (v: string) => v.slice(0, 10);

export function NewEventDialog() {
  const req = open.value;
  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  /*
   * Empty means "no zone at all", which is the default and is not the same as
   * naming the zone you are in. A time with nothing on it is a *floating* time
   * — half nine wherever you are reading it — which is what you want for a run
   * or a haircut and not for a call with somebody in another country. Naming a
   * zone pins it to an instant. Both are useful and only one can be the
   * default, so the default is the one that adds no line to the file.
   */
  const [zone, setZone] = useState("");
  /** A template's `tz:` that is not a zone at all, named rather than swallowed. */
  const [zoneProblem, setZoneProblem] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  /*
   * What the times were before *all day* was ticked, so unticking it puts them
   * back rather than guessing again. A box ticked by mistake should cost the
   * two seconds it took to tick, not the times you had already set.
   */
  const timed = useRef<{ start: string; end: string } | null>(null);

  useEffect(() => {
    if (!req) return;
    const d = defaultEventTimes(req.day);
    setTitle("");
    setAllDay(false);
    setStart(d.start);
    setEnd(d.end);
    /*
     * A template's zone is *shown*, not applied behind your back. Read once,
     * from the folder the chosen day lands in; changing the date afterwards
     * leaves whatever is selected alone, because by then it is your answer
     * rather than the template's suggestion.
     */
    const fromTemplate = templateZoneFor(req.day);
    // A zone that is not one cannot be selected, and must not be saved either.
    const usable = fromTemplate && isKnownZone(fromTemplate);
    setZone(usable ? fromTemplate : "");
    setZoneProblem(fromTemplate && !usable ? fromTemplate : "");
    timed.current = null;
    requestAnimationFrame(() => titleRef.current?.focus());
  }, [req]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open.value = null;
    };
    if (req) addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [req]);

  if (!req) return null;

  const close = () => (open.value = null);

  /** The zone in force. An all-day event never has one: it has no clock. */
  const tzOf = () => (allDay ? undefined : zone || undefined);

  /*
   * Moving the start takes the end with it, keeping the length the event had.
   * Nudging a meeting an hour later should not also mean re-typing when it
   * finishes — and a whole day has no length to keep, so there the end only
   * follows when it would otherwise end before it starts.
   */
  const changeStart = (v: string) => {
    setStart(v);
    if (allDay) {
      if ((instantOf(end) ?? 0) < (instantOf(v) ?? 0)) setEnd(dateOf(v));
    } else {
      setEnd(keepDuration(start, end, v, zone || undefined));
    }
  };

  const toggleAllDay = (on: boolean) => {
    setAllDay(on);
    if (on) {
      timed.current = { start, end };
      setStart(dateOf(start));
      // One day. A timed event that ran to midnight would otherwise become two,
      // which is not what "all day" was asking for.
      setEnd(dateOf(start));
    } else {
      const back = timed.current ?? defaultEventTimes(req.day);
      setStart(back.start);
      setEnd(back.end);
    }
  };

  const submit = async () => {
    const name = title.trim();
    if (!name) return;
    /*
     * Judged in the zone that was chosen, not in the device's.
     *
     * 02:30 to 03:00 in Tokyo is an ordinary half hour; read as New York on the
     * morning its clocks go forward the start moves to 03:30, the end looks
     * like it comes first, and a perfectly valid pair was "corrected" into an
     * hour nobody asked for. An end before its start is still fixed rather than
     * refused — `eventFor` would do the same with one — but the fix has to be
     * judged by the right clock.
     */
    const from = instantOf(start, tzOf());
    if (from === undefined) return;
    const to = instantOf(end, tzOf());
    const fixed =
      to !== undefined && to >= from
        ? end
        : allDay
          ? dateOf(start)
          : wallPlusHour(start);
    close();
    const { path, caret } = await newEventNote(name, start, fixed, tzOf());
    openNote(path, { editing: true, caret });
    notify(`Created ${path}`);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") void submit();
  };
  const type = allDay ? "date" : "datetime-local";

  return (
    <div class="scrim" onClick={close}>
      <div
        class="dialog"
        /* Wider than a one-field dialog: two date-and-time controls side by
           side need the room, and a locale that writes "09/21/2026, 04:00 PM"
           needs more of it than one that writes "21.09.2026, 16:00". */
        style={{ width: "min(470px, 100%)" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div class="dialog-head">
          <h2>New event</h2>
          <span style={{ flex: 1 }} />
          <button class="icon-btn" onClick={close} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div class="dialog-body">
          <label class="field">
            <span>What is it?</span>
            <input
              ref={titleRef}
              class="prompt-input"
              type="text"
              value={title}
              placeholder="Design review"
              autocapitalize="off"
              autocorrect="off"
              spellcheck={false}
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
              onKeyDown={onKey}
            />
          </label>

          <div class="event-when">
            <label class="field">
              <span>Starts</span>
              <input
                class="prompt-input"
                type={type}
                value={start}
                aria-label="Starts"
                onInput={(e) =>
                  changeStart((e.target as HTMLInputElement).value)
                }
                onKeyDown={onKey}
              />
            </label>
            <label class="field">
              <span>Ends</span>
              <input
                class="prompt-input"
                type={type}
                value={end}
                aria-label="Ends"
                onInput={(e) => setEnd((e.target as HTMLInputElement).value)}
                onKeyDown={onKey}
              />
            </label>
          </div>

          {!allDay && (
            <label class="field">
              <span>Time zone</span>
              <select
                value={zone}
                onChange={(e) => {
                  setZone((e.target as HTMLSelectElement).value);
                  setZoneProblem("");
                }}
              >
                <option value="">Local time — wherever this is read</option>
                {/* The selected zone is passed in so the list always holds it:
                    a valid name that is not on the canonical list — `UTC` is
                    not, nor is every alias — would otherwise leave the control
                    showing nothing while saving that name anyway. */}
                {knownZones(zone).map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              {zoneProblem && (
                <small data-invalid="1">
                  The template asks for <code>{zoneProblem}</code>, which is not
                  a time zone this browser knows, so it has been left off.
                </small>
              )}
            </label>
          )}

          <label class="check event-allday">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) =>
                toggleAllDay((e.target as HTMLInputElement).checked)
              }
            />
            <span>All day</span>
          </label>

          <small class="event-lands">
            {/* Worked out the way the note will be: same parser, same zone.
                Device-local, it promised October for a Tokyo midnight that
                saves into September. */}
            Lands in{" "}
            <code>{eventFolderFor(instantOf(start, tzOf()) ?? req.day)}</code>
          </small>
        </div>
        <div class="dialog-foot">
          <span style={{ flex: 1 }} />
          <button class="btn" onClick={close}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            disabled={!title.trim()}
            onClick={() => void submit()}
          >
            Create event
          </button>
        </div>
      </div>
    </div>
  );
}
