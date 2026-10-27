import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionTable, SessionMessageTable } from "@opencode/core/session/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))

const sessionID = Session.ID.make("ses_stale_tools")
const otherSessionID = Session.ID.make("ses_stale_tools_other")
const created = DateTime.makeUnsafe(0)
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Info)
const build = Agent.defaultID

/** An assistant message row whose content holds one tool part in the given state. */
const toolRow = (id: string, session: Session.ID, seq: number, state: SessionMessage.ToolState) => {
  const message = SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: build,
    model,
    content: [
      {
        type: "tool",
        id: `call_${id}`,
        name: "bash",
        state,
        time: { created },
      },
    ],
    time: { created },
  })
  const { id: _, type, ...data } = encodeMessage(message)
  return {
    id: SessionMessage.ID.make(id),
    session_id: session,
    type,
    seq,
    time_created: DateTime.toEpochMillis(created),
    data,
  }
}

const seed = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* Effect.forEach([sessionID, otherSessionID], (id) =>
    db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie),
  )
  yield* db
    .insert(SessionMessageTable)
    .values([
      toolRow("msg_streaming", sessionID, 0, { status: "streaming", input: "{" }),
      toolRow("msg_running", sessionID, 1, {
        status: "running",
        input: { path: "a.txt" },
        metadata: { sessionID: "ses_child" },
      }),
      toolRow("msg_completed", sessionID, 2, {
        status: "completed",
        input: {},
        content: [{ type: "text", text: "done" }],
      }),
      toolRow("msg_error", sessionID, 3, {
        status: "error",
        input: {},
        error: { type: "aborted", message: "interrupted" },
      }),
      // A running tool in another session must never be settled here.
      toolRow("msg_other_running", otherSessionID, 0, { status: "running", input: {}, metadata: {} }),
    ])
    .run()
    .pipe(Effect.orDie)
})

describe("SessionHistory.staleTools", () => {
  it.live("returns only this session's assistant messages carrying a streaming or running tool", () =>
    Effect.gen(function* () {
      yield* seed
      const db = (yield* Database.Service).db
      const stale = yield* SessionHistory.staleTools(db, sessionID)
      expect(stale.map((message) => String(message.id))).toEqual(["msg_streaming", "msg_running"])
      // The running tool keeps its metadata for the failure message.
      const running = stale.find((message) => String(message.id) === "msg_running")
      expect(running?.type === "assistant" ? running.content[0] : undefined).toMatchObject({
        type: "tool",
        state: { status: "running", metadata: { sessionID: "ses_child" } },
      })
    }),
  )

  it.live("drops a message from the result once its tool has finished", () =>
    Effect.gen(function* () {
      yield* seed
      const db = (yield* Database.Service).db
      const only = toolRow("msg_streaming", sessionID, 0, {
        status: "completed",
        input: {},
        content: [{ type: "text", text: "done" }],
      })
      yield* db
        .update(SessionMessageTable)
        .set({ data: only.data })
        .where(eq(SessionMessageTable.id, only.id))
        .run()
        .pipe(Effect.orDie)
      const stale = yield* SessionHistory.staleTools(db, sessionID)
      expect(stale.map((message) => String(message.id))).toEqual(["msg_running"])
    }),
  )
})
