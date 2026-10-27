import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Image } from "@opencode/core/image"
import { Schedule } from "@opencode/core/schedule"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { ScheduleTools } from "@opencode/core/tool/plugin/schedule"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import type { CommandDefinition } from "@opencode/plugin/effect/command"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { codeModeListings, executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_schedule_tool_test")
const otherSessionID = Session.ID.make("ses_schedule_tool_other")
const now = DateTime.makeUnsafe("2026-10-27T13:00:00Z")
const names = ["schedule_create", "schedule_list", "schedule_pause", "schedule_resume", "schedule_delete"].map(
  (name) => `opencode.${name}`,
)

const it = testEffect(AppNodeBuilder.build(Tool.node, [Image.node.replace(imagePassthrough)]))

/** An in-memory Schedule service. The real one is covered in schedule.test.ts; this exercises the tool layer. */
const memory = () => {
  const rows = new Map<Schedule.ID, Schedule.Info>()
  const find = (id: Schedule.ID): Effect.Effect<Schedule.Info, Schedule.NotFoundError> => {
    const info = rows.get(id)
    return info ? Effect.succeed(info) : Effect.fail(new Schedule.NotFoundError({ scheduleID: id }))
  }
  const update = (id: Schedule.ID, status: Schedule.Info["status"]) =>
    find(id).pipe(
      Effect.map((info) => {
        const next = { ...info, status }
        rows.set(id, next)
        return next
      }),
    )
  const service = Schedule.Service.of({
    create: (input) =>
      Effect.sync(() => {
        const info: Schedule.Info = {
          id: Schedule.ID.make(`sch_${rows.size + 1}`),
          sessionID: input.sessionID,
          name: input.name,
          when: input.when,
          tz: "America/New_York",
          action: input.action,
          status: "active",
          nextDueAt: DateTime.add(now, { minutes: 20 }),
          runCount: 0,
          time: { created: now, updated: now },
        }
        rows.set(info.id, info)
        return info
      }),
    list: (input) => Effect.sync(() => [...rows.values()].filter((info) => info.sessionID === input?.sessionID)),
    get: find,
    pause: (id) => update(id, "paused"),
    resume: (id) => update(id, "active"),
    remove: (id) => find(id).pipe(Effect.map(() => void rows.delete(id))),
    enabled: () => Effect.succeed(true),
    tick: Effect.void,
    run: Effect.never,
  })
  return { rows, service }
}

const setup = (experimental: ConfigExperimental.Info | undefined) =>
  Effect.gen(function* () {
    const schedules = memory()
    const commands: CommandDefinition[] = []
    const prompts: unknown[] = []
    yield* registerToolPlugin(ScheduleTools.Plugin, {
      event: { subscribe: () => Stream.never },
      command: {
        list: () => Effect.die("unused command.list"),
        reload: () => Effect.void,
        transform: (callback) =>
          Effect.sync(() => {
            callback({ add: (definition) => commands.push(definition) })
            return { dispose: Effect.void }
          }),
      },
      session: { prompt: (input) => Effect.sync(() => prompts.push(input)).pipe(Effect.as(undefined as never)) },
    }).pipe(
      Effect.provide(Layer.mock(Config.Service)({ entries: () => Effect.succeed([document(experimental)]) })),
      Effect.provide(Layer.succeed(Schedule.Service, schedules.service)),
      Effect.provide(permissionLayer({ assert: () => Effect.void })),
    )
    return { registry: yield* Tool.Service, rows: schedules.rows, commands, prompts }
  })

/** Runs one Code Mode call, the way the model reaches these tools. */
const call = (registry: Tool.Interface, name: string, input: unknown, session = sessionID) =>
  executeTool(registry, {
    sessionID: session,
    ...toolIdentity,
    call: {
      type: "tool-call",
      id: `call-${name}`,
      name: "execute",
      input: { code: `return await tools.opencode.${name}(${JSON.stringify(input)})` },
    },
  })
const run = (registry: Tool.Interface, name: string, input: unknown, session = sessionID) =>
  call(registry, name, input, session).pipe(
    Effect.map((result) => JSON.parse(result.content?.[0]?.type === "text" ? result.content[0].text : "")),
  )

const paths = (registry: Tool.Interface) =>
  registry
    .snapshot()
    .pipe(
      Effect.map((snapshot) =>
        snapshot.codeModeCatalog ? codeModeListings(snapshot.codeModeCatalog).map((tool) => tool.path) : [],
      ),
    )

describe("ScheduleTools", () => {
  it.effect("are absent unless experimental.schedules is enabled", () =>
    Effect.gen(function* () {
      expect(yield* paths((yield* setup(undefined)).registry)).not.toContain(names[0])
      const off = yield* setup(new ConfigExperimental.Info({ schedules: false }))
      expect(yield* paths(off.registry)).not.toContain(names[0])
      expect(off.commands).toEqual([])
      const on = yield* setup(new ConfigExperimental.Info({ schedules: true }))
      expect(yield* paths(on.registry)).toEqual(expect.arrayContaining(names))
      expect(on.commands.map((command) => command.name)).toEqual(["schedule"])
    }),
  )

  it.effect("creates, lists, pauses, resumes and deletes this session's schedules", () =>
    Effect.gen(function* () {
      const { registry, rows } = yield* setup(new ConfigExperimental.Info({ schedules: true }))

      expect(
        yield* run(registry, "schedule_create", {
          name: "build",
          when: { in: "20 minutes" },
          prompt: "check the build",
        }),
      ).toMatchObject({
        id: "sch_1",
        name: "build",
        when: { type: "in", in: "20 minutes" },
        prompt: "check the build",
        status: "active",
        nextDueAt: "2026-10-27T09:20:00.000-04:00",
      })
      expect([...rows.values()][0]).toMatchObject({ sessionID, action: { type: "prompt", prompt: "check the build" } })

      expect(yield* run(registry, "schedule_list", {})).toMatchObject({
        schedules: [{ id: "sch_1", status: "active" }],
      })
      expect(yield* run(registry, "schedule_pause", { id: "sch_1" })).toMatchObject({ status: "paused" })
      expect(yield* run(registry, "schedule_resume", { id: "sch_1" })).toMatchObject({ status: "active" })
      expect(yield* run(registry, "schedule_delete", { id: "sch_1" })).toEqual({ id: "sch_1", removed: true })
      expect(rows.size).toBe(0)
    }),
  )

  it.effect("/schedule hands the request to the model with the schedule instructions", () =>
    Effect.gen(function* () {
      const { commands, prompts } = yield* setup(new ConfigExperimental.Info({ schedules: true }))
      yield* commands[0]!
        .execute({
          sessionID,
          prompt: { text: "  every morning at 9 check CI  " },
          delivery: "steer",
        })
        .pipe(Effect.orDie)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({ sessionID, delivery: "steer" })
      const text = (prompts[0] as { text: string }).text
      expect(text).toContain("every morning at 9 check CI")
      expect(text).not.toContain("$ARGUMENTS")
    }),
  )

  it.effect("treats another session's schedule as missing", () =>
    Effect.gen(function* () {
      const { registry, rows } = yield* setup(new ConfigExperimental.Info({ schedules: true }))
      yield* run(registry, "schedule_create", { when: { every: "1 hour" }, prompt: "ping" }, otherSessionID)

      expect(yield* run(registry, "schedule_list", {})).toMatchObject({ schedules: [] })
      for (const name of ["schedule_pause", "schedule_resume", "schedule_delete"]) {
        expect(yield* call(registry, name, { id: "sch_1" })).toMatchObject({
          content: [{ type: "text", text: expect.stringContaining("Schedule not found: sch_1") }],
          metadata: { error: true },
        })
      }
      expect(rows.get(Schedule.ID.make("sch_1"))).toMatchObject({ status: "active", sessionID: otherSessionID })
    }),
  )
})

function document(experimental: ConfigExperimental.Info | undefined): Entry {
  return new Document({ type: "document", info: new Info(experimental ? { experimental } : {}) })
}
