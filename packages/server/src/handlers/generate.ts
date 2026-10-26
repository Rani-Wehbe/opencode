import { Generate } from "@opencode/core/generate"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { InvalidRequestError, NotImplementedError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { Global } from "@opencode/util/global"
import { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { awaitPlugins, locationErrors } from "../location"

export const GenerateHandler = HttpApiBuilder.group(Api, "server.generate", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
    const text = Effect.fn("server.generate.text")(
      function* (request: { readonly payload: { readonly prompt: string; readonly model?: Model.Ref } }) {
        yield* awaitPlugins
        const generate = yield* Generate.Service
        const text = yield* generate
          .text(request.payload)
          .pipe(
            Effect.mapError((error) =>
              error._tag === "Generate.ModelSelectionError"
                ? new InvalidRequestError({ message: error.message })
                : new ServiceUnavailableError({ message: error.message, service: error.service }),
            ),
          )
        return { data: { text } }
      },
      Effect.provide(services),
      locationErrors,
    )
    return handlers
      .handle("generate.text", text)
      .handle("generate.textLegacy", text)
      .handle("generate.image", () =>
        Effect.fail(new NotImplementedError({ message: "Image generation is not implemented yet" })),
      )
      .handle("generate.decisions", (request) =>
        new Set(request.payload.questions.map((question) => question.name)).size === request.payload.questions.length
          ? Effect.fail(new NotImplementedError({ message: "Decision generation is not implemented yet" }))
          : Effect.fail(
              new InvalidRequestError({ message: "Decision question names must be unique", field: "questions" }),
            ),
      )
  }),
)
