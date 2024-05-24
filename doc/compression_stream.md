# Zstandard (De)Compression and XChaCha20-Poly1305 [De/En]cryption streaming

## How should this work, exactly?

I want to take a file and produce a pair of pipelines of TransformStreams which perform compression->encryption and decryption->decompression.
When I say "file" here, I do not mean specifically a single TGLFS chunk, but instead a whole reconstituted multi-chunk file.
So when performing the decryption->decompression pipeline action, we should be able to decrypt and decompress a single file across multiple chunks without producing a new stream each time.

In particular, in Zstandard (with `zstd-codec`) we should use streaming.compressChunks and streaming.decompressChunks with a generator approach so that huge files (that exceed the amount of space in the client's RAM) can be processed in chunks.

In XChaCha20-Poly1305 (with `libsodium-wrappers-sumo`) we should carefully manage state so that it is properly maintained and mutated across multiple chunks (both streaming chunks, as WebStreams tend to segment chunks at arbitrary size delimitations, and actual file chunks, which are usually either roughly 2gb or 4gb in size and occupy different files on the Origin Private File System (both being written to during the compression->encryption pipeline and being read from during the decryption->decompression pipeline)).

Here's the documentation for `zstd-codec`, from NPM:

```
zstd-codec
Zstandard codec for Node.js and Web, powered by Emscripten.

Languages
English
Description
zstd-codec is a binding of Zstandard for Node.js and Browsers, includes JavaScript port of Zstandard compiled with Emscripten.

Installation
npm

npm install zstd-codec
yarn

yarn add zstd-codec
Usage
require module, and instantiate api objects.

const ZstdCodec = require('zstd-codec').ZstdCodec;
ZstdCodec.run(zstd => {
    const simple = new zstd.Simple();
    const streaming = new zstd.Streaming();
});
Use Simple API for small data
Use Streaming API for large data
Simple API
Using Zstandard's Simple API
ZSTD_compress for compress
ZSTD_decompress for decompress
Store whole input/output bytes into Emscripten's heap
Available Emscripten's heap size is 16MiB
(input.length + output.length) should be less than 12MiB
compress(content_bytes, compression_level)
content_bytes: data to compress, must be Uint8Array.
compression_level: (optional) compression level, default value is 3
// prepare data to compress
const data = ...;

// compress
const level = 5;
const compressed = simple.compress(data, level);

// handle compressed data
do_something(compressed);
decompress(compressed_bytes)
compressed_bytes: data to decompress, must be Uint8Array.
// prepare compressed data
const compressed = ...;

// decompress
const data = simple.decompress(compressed);

// handle decompressed data
do_something(data);
Streaming APIs
Using Zstandard's Streaming API
ZSTD_xxxxCStream APIs for compress
ZSTD_xxxxDStream APIs for decompress
Store partial input/output bytes into Emscripten's heap
const streaming = new ZstdCodec.Streaming();
You can use custom Iterable object on compressChunks / decompressChunks.

compress(content_bytes, compression_level)
content_bytes: data to compress, must be 'Uint8Array'
compression_level: (optional) compression level, default value is 3
const compressed = streaming.compress(data); // use default compression_level 3
compressChunks(chunks, size_hint, compression_level)
chunks: data chunks to compress, must be Iterable of Uint8Array
size_hint: (optional) size hint to store compressed data (to improve performance)
compression_level: (optional) compression level, default value is 3
const chunks = [dataPart1, dataPart2, dataPart3, ...];
const size_hint = chunks.map((ar) => ar.length).reduce((p, c) => p + c);
const compressed = streaming.compressChunks(chunks, size_hint); // use default compression_level 3
decompress(compressed_bytes, size_hint)
compressed_bytes: data to decompress, must be Uint8Array.
size_hint: (optional) size hint to store decompressed data (to improve performance)
const data = streaming.decompress(data); // can omit size_hint
decompressChunks(chunks, size_hint)
chunks: data chunks to compress, must be Iterable of Uint8Array
size_hint: (optional) size hint to store compressed data (to improve performance)
const chunks = [dataPart1, dataPart2, dataPart3, ...];
const size_hint = 2 * 1024 * 1024; // 2MiB
const data = streaming.decompressChunks(chunks, size_hint);
Dictionary API
const ZstdCodec = require('zstd-codec').ZstdCodec;
ZstdCodec.run(zstd => {
    const simple = new zstd.Simple();

    // compress using trained dictionary
    const cdict = new zstd.Dict.Compression(dict_bytes, compression_level);
    const compressed = simple.compressUsingDict(data, cdict);

    // decompress using trained dictionary
    const ddict = new zstd.Dict.Decompression(dict_bytes);
    const data = simple.decompressUsingDict(compressed, ddict);
});
Migrate from v0.0.x to v0.1.x
API changed
please use callback style module instantiation.

// v0.0.x
const zstd = require('zstd-codec').ZstdCodec;
const simple = new zstd.Simple();

// v0.1.x
const ZstdCodec = require('zstd-codec').ZstdCodec;
ZstdCodec.run(zstd => {
    const simple = new zstd.Simple();
});
NOTE: I wanted to use Promise instead of callback, but does not work :( Need to survey why promise does not work, but it will take a lot of times.

Class name changed
ZstdCompressionDict => zsdt.Dict.Compression
ZstdDecompressionDict => zsdt.Dict.Decompression
Example
Browser
See the document.

Node.js
TODO: add an example for Node.js.

TODO
add CI (Travis CI or Circle CI?)
improve APIs
write this document
add how to build zstd with Emsxcripten
add how to test
performance test
add more tests
Readme
Keywords
none
```

Here's the documentation for `libsodium-wrappers-sumo`, from NPM:

```
libsodium.js
Overview
The sodium crypto library compiled to WebAssembly and pure JavaScript using Emscripten, with automatically generated wrappers to make it easy to use in web applications.

The complete library weighs 188 KB (minified, gzipped, includes pure JS + WebAssembly versions) and can run in a web browser as well as server-side.

Compatibility
Supported browsers/JS engines:

Chrome >= 16
Edge >= 0.11
Firefox >= 21
Mobile Safari on iOS >= 8.0 (older versions produce incorrect results)
NodeJS
Bun
Opera >= 15
Safari >= 6 (older versions produce incorrect results)
This is comparable to the WebCrypto API, which is compatible with a similar number of browsers.

Signatures and other Edwards25519-based operations are compatible with WasmCrypto.

Installation
The dist directory contains pre-built scripts. Copy the files from one of its subdirectories to your application:

browsers includes a single-file script that can be included in web pages. It contains code for commonly used functions.
browsers-sumo is a superset of the previous script, that contains all functions, including rarely used ones and undocumented ones.
modules includes commonly used functions, and is designed to be loaded as a module. libsodium-wrappers is the module your application should load, which will in turn automatically load libsodium as a dependency.
modules-sumo contains sumo variants of the previous modules.
The modules are also available on npm:

libsodium-wrappers
libsodium-wrappers-sumo
If you prefer Bower:

bower install libsodium.js
Usage (as a module)
Load the libsodium-wrappers module. The returned object contains a .ready property: a promise that must be resolve before the sodium functions can be used.

Example:

import _sodium from 'libsodium-wrappers';
await (async() => {
  await _sodium.ready;
  const sodium = _sodium;

  let key = sodium.crypto_secretstream_xchacha20poly1305_keygen();

  let res = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  let [state_out, header] = [res.state, res.header];
  let c1 = sodium.crypto_secretstream_xchacha20poly1305_push(state_out,
    sodium.from_string('message 1'), null,
    sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
  let c2 = sodium.crypto_secretstream_xchacha20poly1305_push(state_out,
    sodium.from_string('message 2'), null,
    sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL);

  let state_in = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
  let r1 = sodium.crypto_secretstream_xchacha20poly1305_pull(state_in, c1);
  let [m1, tag1] = [sodium.to_string(r1.message), r1.tag];
  let r2 = sodium.crypto_secretstream_xchacha20poly1305_pull(state_in, c2);
  let [m2, tag2] = [sodium.to_string(r2.message), r2.tag];

  console.log(m1);
  console.log(m2);
})();
Usage (in a web browser, via a callback)
The sodium.js file includes both the core libsodium functions, as well as the higher-level JavaScript wrappers. It can be loaded asynchronusly.

A sodium object should be defined in the global namespace, with the following property:

onload: the function to call after the wrapper is initialized.
Example:

<script>
    window.sodium = {
        onload: function (sodium) {
            let h = sodium.crypto_generichash(64, sodium.from_string('test'));
            console.log(sodium.to_hex(h));
        }
    };
</script>
<script src="sodium.js" async></script>
Additional helpers
from_base64(), to_base64() with an optional second parameter whose value is one of: base64_variants.ORIGINAL, base64_variants.ORIGINAL_NO_PADDING, base64_variants.URLSAFE or base64_variants.URLSAFE_NO_PADDING. Default is base64_variants.URLSAFE_NO_PADDING.
from_hex(), to_hex()
from_string(), to_string()
pad(<buffer>, <block size>), unpad(<buffer>, <block size>)
memcmp() (constant-time check for equality, returns true or false)
compare() (constant-time comparison. Values must have the same size. Returns -1, 0 or 1)
memzero() (applies to Uint8Array objects)
increment() (increments an arbitrary-long number stored as a little-endian Uint8Array - typically to increment nonces)
add() (adds two arbitrary-long numbers stored as little-endian Uint8Array vectors)
is_zero() (constant-time, checks Uint8Array objects for all zeros)
API
The API exposed by the wrappers is identical to the one of the C library, except that buffer lengths never need to be explicitly given.

Binary input buffers should be Uint8Array objects. However, if a string is given instead, the wrappers will automatically convert the string to an array containing a UTF-8 representation of the string.

Example:

var key = sodium.randombytes_buf(sodium.crypto_shorthash_KEYBYTES),
    hash1 = sodium.crypto_shorthash(new Uint8Array([1, 2, 3, 4]), key),
    hash2 = sodium.crypto_shorthash('test', key);
If the output is a unique binary buffer, it is returned as a Uint8Array object.

Example (secretbox):

let key = sodium.from_hex('724b092810ec86d7e35c9d067702b31ef90bc43a7b598626749914d6a3e033ed');

function encrypt_and_prepend_nonce(message) {
    let nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    return nonce.concat(sodium.crypto_secretbox_easy(message, nonce, key));
}

function decrypt_after_extracting_nonce(nonce_and_ciphertext) {
    if (nonce_and_ciphertext.length < sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES) {
        throw "Short message";
    }
    let nonce = nonce_and_ciphertext.slice(0, sodium.crypto_secretbox_NONCEBYTES),
        ciphertext = nonce_and_ciphertext.slice(sodium.crypto_secretbox_NONCEBYTES);
    return sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
}
In addition, the from_hex, to_hex, from_string, and to_string functions are available to explicitly convert hexadecimal, and arbitrary string representations from/to Uint8Array objects.

Functions returning more than one output buffer are returning them as an object. For example, the sodium.crypto_box_keypair() function returns the following object:

{ keyType: 'curve25519', privateKey: (Uint8Array), publicKey: (Uint8Array) }
Standard vs Sumo version
The standard version (in the dist/browsers and dist/modules directories) contains the high-level functions, and is the recommended one for most projects.

Alternatively, the "sumo" version, available in the dist/browsers-sumo and dist/modules-sumo directories contains all the symbols from the original library. This includes undocumented, untested, deprecated, low-level and easy to misuse functions.

The crypto_pwhash_* function set is only included in the sumo version.

The sumo version is slightly larger than the standard version, reserves more memory, and should be used only if you really need the extra symbols it provides.
```

Here's the documentation for `TransformStream`, from MDN:

```
The TransformStream interface of the Streams API represents a concrete implementation of the pipe chain transform stream concept.

It may be passed to the ReadableStream.pipeThrough() method in order to transform a stream of data from one format into another. For example, it might be used to decode (or encode) video frames, decompress data, or convert the stream from XML to JSON.

A transformation algorithm may be provided as an optional argument to the object constructor. If not supplied, data is not modified when piped through the stream.

TransformStream is a transferable object.

Constructor
TransformStream()
Creates and returns a transform stream object, optionally specifying a transformation object and queuing strategies for the streams.

Instance properties
TransformStream.readable Read only
The readable end of a TransformStream.

TransformStream.writable Read only
The writable end of a TransformStream.

Instance methods
None

Examples
Anything-to-uint8array stream
In the following example, a transform stream passes through all chunks it receives as Uint8Array values.

JS
Copy to Clipboard
const transformContent = {
  start() {}, // required.
  async transform(chunk, controller) {
    chunk = await chunk;
    switch (typeof chunk) {
      case "object":
        // just say the stream is done I guess
        if (chunk === null) {
          controller.terminate();
        } else if (ArrayBuffer.isView(chunk)) {
          controller.enqueue(
            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          );
        } else if (
          Array.isArray(chunk) &&
          chunk.every((value) => typeof value === "number")
        ) {
          controller.enqueue(new Uint8Array(chunk));
        } else if (
          typeof chunk.valueOf === "function" &&
          chunk.valueOf() !== chunk
        ) {
          this.transform(chunk.valueOf(), controller); // hack
        } else if ("toJSON" in chunk) {
          this.transform(JSON.stringify(chunk), controller);
        }
        break;
      case "symbol":
        controller.error("Cannot send a symbol as a chunk part");
        break;
      case "undefined":
        controller.error("Cannot send undefined as a chunk part");
        break;
      default:
        controller.enqueue(this.textencoder.encode(String(chunk)));
        break;
    }
  },
  flush() {
    /* do any destructor work here */
  },
};

class AnyToU8Stream extends TransformStream {
  constructor() {
    super({ ...transformContent, textencoder: new TextEncoder() });
  }
}
Polyfilling TextEncoderStream and TextDecoderStream
Note that this is deprecated by the native constructors. This is intended as a polyfill for unsupported platforms.

JS
Copy to Clipboard
const tes = {
  start() {
    this.encoder = new TextEncoder();
  },
  transform(chunk, controller) {
    controller.enqueue(this.encoder.encode(chunk));
  },
};

let _jstes_wm = new WeakMap(); /* info holder */
class JSTextEncoderStream extends TransformStream {
  constructor() {
    let t = { ...tes };

    super(t);
    _jstes_wm.set(this, t);
  }
  get encoding() {
    return _jstes_wm.get(this).encoder.encoding;
  }
}
Similarly, TextDecoderStream can be written as such:

JS
Copy to Clipboard
const tds = {
  start() {
    this.decoder = new TextDecoder(this.encoding, this.options);
  },
  transform(chunk, controller) {
    controller.enqueue(this.decoder.decode(chunk, { stream: true }));
  },
};

let _jstds_wm = new WeakMap(); /* info holder */
class JSTextDecoderStream extends TransformStream {
  constructor(encoding = "utf-8", { ...options } = {}) {
    let t = { ...tds, encoding, options };

    super(t);
    _jstds_wm.set(this, t);
  }
  get encoding() {
    return _jstds_wm.get(this).decoder.encoding;
  }
  get fatal() {
    return _jstds_wm.get(this).decoder.fatal;
  }
  get ignoreBOM() {
    return _jstds_wm.get(this).decoder.ignoreBOM;
  }
}
Chaining multiple ReadableStreams together
This is a useful one, where multiple streams can be conjoined. Examples include building a PWA with progressive loading and progressive streaming.

JS
Copy to Clipboard
let responses = [
  /* conjoined response tree */
];
let { readable, writable } = new TransformStream();

responses.reduce(
  (a, res, i, arr) =>
    a.then(() => res.pipeTo(writable, { preventClose: i + 1 !== arr.length })),
  Promise.resolve(),
);
Note that this is not resilient to other influences.
```
