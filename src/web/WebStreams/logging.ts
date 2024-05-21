/**
 * Streaming logging utilities.
 * @module logging
 */

export class LoggingStream {
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController) {
        const toBase64 = (buffer: Uint8Array) => {
            let binary = '';
            const len = buffer.byteLength;
            for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(buffer[i]);
            }
            return btoa(binary);
        };
        
        console.log("Compressed and Encrypted:", toBase64(chunk));
        controller.enqueue(chunk);
    }
}