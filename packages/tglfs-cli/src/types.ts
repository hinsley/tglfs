export type PersistedConfig = {
    apiId: number
    apiHash: string
    phone: string
}

export type FileCardData = {
    name: string
    ufid: string
    size: number
    uploadComplete: boolean
    chunks: number[]
    IV: string
}

export type FileCardRecord = {
    msgId: number
    date: number
    data: FileCardData
}

export type JsonEnvelope<T> =
    | {
          ok: true
          data: T
      }
    | {
          ok: false
          error: {
              code: string
              message: string
              details?: unknown
          }
      }
