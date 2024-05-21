/**
 * Streaming compression utilities.
 * @module compression
 */

import { ZstdCodec } from 'zstd-codec';

export class ZstdCompressStream {
    async transform(chunk: Uint8Array, controller: TransformStreamDefaultController) {
        try {
            console.log("Compressing chunk...");
            await new Promise<void>((resolve, reject) => {
                ZstdCodec.run((zstd: any) => { // Initialize ZstdCodec
                    console.log("ZstdCodec initialized.");
                    const streaming = new zstd.Streaming();
                    const compressed = streaming.compress(chunk);
                    console.log("Compression complete. Enqueueing chunk...");
                    try {
                        controller.enqueue(compressed);
                        console.log("Compression successful, chunk enqueued.");
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
            });
        } catch (error) {
            console.error("Compression error:", error);
            controller.error(error);
        }
    }
}

export class ZstdDecompressStream {
    async transform(chunk: Uint8Array, controller: TransformStreamDefaultController) {
        try {
            console.log("Decompressing chunk...");
            await new Promise<void>((resolve, reject) => {
                ZstdCodec.run((zstd: any) => { // Initialize ZstdCodec
                    console.log("ZstdCodec initialized.");
                    const streaming = new zstd.Streaming();
                    const decompressed = streaming.decompress(chunk);
                    console.log("Decompression complete. Enqueueing chunk...");
                    try {
                        controller.enqueue(decompressed);
                        console.log("Decompression successful, chunk enqueued.");
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
            });
        } catch (error) {
            console.error("Decompression error:", error);
            controller.error(error);
        }
    }
}