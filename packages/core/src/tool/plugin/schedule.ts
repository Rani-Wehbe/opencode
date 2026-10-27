export * as ScheduleTools from "./schedule.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { optional } from "@opencode/schema/schema"
import type { Session } from "@opencode/schema/session"
import { DateTime, Effect, Option, Schema } from "effect"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import PROMPT_SCHEDULE from "../../plugin/command/schedule.txt"
import { Schedule } from "../../schedule.js"

/** A schedule as the model reads it, with times in the schedule's own zone. */
export const View = Schema.Struct({
  id: Schedule.ID,
  name: Schema.String.pipe(optional),
  when: Schedule.When,
  tz: Schema.String,
  prompt: Schema.String,
  status: Schedule.Status,
  nextDueAt: Schema.String.pipe(optional),
  endsAt: Schema.String.pipe(optional),
  remainingRuns: Schema.Number.pipe(optional),
  runCount: Schema.Number,
  lastFiredAt: Schema.String.pipe(optional),
  lastOutcome: Schedule.Outcome.pipe(optional),
})
export type View = typeof View.Type

const ListOutput = Schema.Struct({
  now: Schema.String.annotate({ description: "The current time, in UTC." }),
  schedules: Schema.Array(View),
})

export const IDInput = Schema.Struct({
  id: Schedule.ID.annotate({ description: "Schedule id from schedule_list." }),
})

const RemoveOutput = Schema.Struct({ id: Schedule.ID, removed: Schema.Boolean })

export const Plugin = {
  id: "opencode.tool.schedule",
  effect: Effect.fn("ScheduleTools.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service
    const schedules = yield* Schedule.Service
    // Internal plugins are not re-run on config changes, so reload the tools and the command instead.
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      Effect.andThen(ctx.tool.reload(), ctx.command.reload()),
    )
    const enabled = () => Config.latest(loaded.entries, "experimental")?.schedules === true

    // Tools act only on the calling Session's schedules.
    const owned = (id: Schedule.ID, sessionID: Session.ID) =>
      schedules.get(id).pipe(
        Effect.filterOrFail(
          (info) => info.sessionID === sessionID,
          () => new Schedule.NotFoundError({ scheduleID: id }),
        ),
      )
    const notFound = (error: Schedule.NotFoundError) =>
      new ToolFailure({ message: `Schedule not found: ${error.scheduleID}`, error })

    yield* ctx.tool
      .transform((editor) => {
        if (!enabled()) return
        editor.add({
          name: "schedule_create",
          description:
            "Schedule a prompt that wakes this session later: once after a delay, at a time, every interval, or on a cron. Returns the schedule with its next run.",
          input: Schedule.Request,
          output: View,
          options: { namespace: "opencode", codemode: true },
          execute: (input, context) =>
            schedules.create(Schedule.toCreateInput(context.sessionID, input)).pipe(
              Effect.map((info) => {
                const view = toView(info)
                return {
                  output: view,
                  content: view.nextDueAt
                    ? `Scheduled ${view.name ?? view.id}; next run ${view.nextDueAt}.`
                    : `Scheduled ${view.name ?? view.id}.`,
                }
              }),
              Effect.mapError(
                (error) => new ToolFailure({ message: error.message || "Unable to create schedule", error }),
              ),
            ),
        })
        editor.add({
          name: "schedule_list",
          description: "List this session's schedules with their status and next run, and the current time.",
          input: Schema.Struct({}),
          output: ListOutput,
          options: { namespace: "opencode", codemode: true },
          execute: (_, context) =>
            Effect.gen(function* () {
              const now = DateTime.formatIso(yield* DateTime.now)
              const list = (yield* schedules.list({ sessionID: context.sessionID })).map(toView)
              return {
                output: { now, schedules: list },
                content: list.length === 0 ? "No schedules." : `${list.length} schedule(s).`,
              }
            }),
        })
        editor.add({
          name: "schedule_pause",
          description: "Pause a schedule. It keeps its settings and does not fire until resumed.",
          input: IDInput,
          output: View,
          options: { namespace: "opencode", codemode: true },
          execute: (input, context) =>
            owned(input.id, context.sessionID).pipe(
              Effect.andThen(schedules.pause(input.id)),
              Effect.map((info) => ({ output: toView(info), content: `Paused ${info.name ?? info.id}.` })),
              Effect.mapError(notFound),
            ),
        })
        editor.add({
          name: "schedule_resume",
          description:
            "Resume a paused schedule. A one-shot that fell due while paused fires once now; a repeating one resumes at its next slot.",
          input: IDInput,
          output: View,
          options: { namespace: "opencode", codemode: true },
          execute: (input, context) =>
            owned(input.id, context.sessionID).pipe(
              Effect.andThen(schedules.resume(input.id)),
              Effect.map((info) => ({ output: toView(info), content: `Resumed ${info.name ?? info.id}.` })),
              Effect.mapError(notFound),
            ),
        })
        editor.add({
          name: "schedule_delete",
          description: "Delete a schedule for good.",
          input: IDInput,
          output: RemoveOutput,
          options: { namespace: "opencode", codemode: true },
          execute: (input, context) =>
            owned(input.id, context.sessionID).pipe(
              Effect.andThen(schedules.remove(input.id)),
              Effect.as({ output: { id: input.id, removed: true }, content: `Deleted schedule ${input.id}.` }),
              Effect.mapError(notFound),
            ),
        })
      })
      .pipe(Effect.orDie)

    yield* ctx.command.transform((editor) => {
      if (!enabled()) return
      editor.add({
        name: "schedule",
        description: "schedule a prompt for later, or list, pause and delete this session's schedules",
        execute: (input) =>
          ctx.session
            .prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text: PROMPT_SCHEDULE.replaceAll("$ARGUMENTS", () => input.prompt.text.trim()),
              delivery: input.delivery,
            })
            .pipe(Effect.asVoid),
      })
    })
  }),
}

function toView(info: Schedule.Info): View {
  const local = (time: DateTime.Utc | undefined) => {
    if (time === undefined) return undefined
    return Option.match(DateTime.zoneMakeNamed(info.tz), {
      onNone: () => DateTime.formatIso(time),
      onSome: (zone) => DateTime.formatIsoOffset(DateTime.setZone(time, zone)),
    })
  }
  return {
    id: info.id,
    name: info.name,
    when: info.when,
    tz: info.tz,
    prompt: info.action.prompt,
    status: info.status,
    nextDueAt: local(info.nextDueAt),
    endsAt: local(info.endsAt),
    remainingRuns: info.remainingRuns,
    runCount: info.runCount,
    lastFiredAt: local(info.lastFiredAt),
    lastOutcome: info.lastOutcome,
  }
}
