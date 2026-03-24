export type PersistedConfig = {
    apiId: number
    apiHash: string
    chunkSize: number
    phone: string
}

export type { FileCardData, FileCardRecord } from "./shared/file-cards.js"

export type JsonEnvelope<T extends Record<string, unknown>> =
    | ({
          ok: true
      } & T)
    | {
          ok: false
          error: {
              code: string
              message: string
              details?: unknown
          }
      }
