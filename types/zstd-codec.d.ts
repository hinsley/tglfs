// types/zstd-codec.d.ts
declare module "zstd-codec" {
    interface ZstdCodec {
        run(callback: (zstd: ZstdCodec) => void): void
        Streaming: typeof Streaming
        Simple: typeof Simple
    }

    // No streaming; for small files only.
    class Simple {
        constructor()
        compress(data: Uint8Array, compression_level?: number): Uint8Array
        decompress(data: Uint8Array): Uint8Array
    }

    // Streaming; may be used for large files.
    class Streaming {
        constructor()
        compress(data: Uint8Array, compression_level?: number): Uint8Array
        compressChunks(chunks: (Uint8Array)[], size_hint?: number, compression_level?: number): Buffer
        decompress(data: Uint8Array, size_hint?: number): Uint8Array
        decompressChunks(chunks: (Uint8Array)[], size_hint?: number): Buffer
    }

    export const ZstdCodec: ZstdCodec
}
