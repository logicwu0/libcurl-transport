/**
 * Post-install script: patches libcurl.js to add `add_cacert()` API
 * without recompiling the WASM binary.
 *
 * How it works:
 *   1. Injects an `add_cacert(pem)` function into the libcurl closure.
 *   2. The function allocates new WASM memory, writes (old PEM + new PEM),
 *      then locates the `cacert_blob` struct in WASM memory by searching
 *      for the original data pointer, and updates blob.data + blob.len.
 *   3. Exposes it on the `api` object so callers can use `libcurl.add_cacert()`.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Find libcurl.js package in node_modules
let libcurlDir;
try {
  const libcurlMain = require.resolve("libcurl.js/bundled");
  libcurlDir = dirname(libcurlMain);
} catch {
  // Try common locations
  libcurlDir = resolve("node_modules/libcurl.js");
}

const filesToPatch = ["libcurl_full.js", "libcurl_full.mjs", "libcurl.js", "libcurl.mjs"];

const ADD_CACERT_FN = `
function add_cacert(pem_cert) {
  check_loaded(false);
  var old_ptr = _get_cacert();
  var old_pem = UTF8ToString(old_ptr);
  var new_pem = old_pem + "\\n" + pem_cert;
  var new_len = lengthBytesUTF8(new_pem) + 1;
  var new_ptr = _malloc(new_len);
  stringToUTF8(new_pem, new_ptr, new_len);
  // Update ALL occurrences of {old_ptr, ~old_len} in HEAP32
  // (covers both the cacert_pem/cacert_pem_len globals and the cacert_blob struct)
  var heap32 = HEAP32;
  var old_len = lengthBytesUTF8(old_pem);
  var updated = 0;
  for (var i = 0; i < heap32.length; i++) {
    if (heap32[i] === old_ptr) {
      if (heap32[i + 1] === old_len || heap32[i + 1] === old_len + 1 || heap32[i + 1] === old_len - 1) {
        heap32[i] = new_ptr;
        heap32[i + 1] = new_len - 1;
        updated++;
      }
    }
  }
  if (updated === 0) throw new Error("add_cacert: could not locate cacert_blob in WASM memory");
}
`;

let patched = 0;

for (const filename of filesToPatch) {
  const filepath = resolve(libcurlDir, filename);
  if (!existsSync(filepath)) continue;

  let content = readFileSync(filepath, "utf-8");

  // Skip if already patched
  if (content.includes("function add_cacert")) {
    console.log(`[patch-libcurl] ${filename}: already patched, skipping`);
    patched++;
    continue;
  }

  // 1. Inject add_cacert function after get_cacert function
  const marker = "function get_cacert() {";
  const markerIdx = content.indexOf(marker);
  if (markerIdx === -1) {
    console.log(`[patch-libcurl] ${filename}: get_cacert not found, skipping`);
    continue;
  }

  // Find the closing brace of get_cacert()
  let braceCount = 0;
  let insertPos = -1;
  for (let i = markerIdx; i < content.length; i++) {
    if (content[i] === "{") braceCount++;
    if (content[i] === "}") {
      braceCount--;
      if (braceCount === 0) {
        insertPos = i + 1;
        break;
      }
    }
  }

  if (insertPos === -1) {
    console.log(`[patch-libcurl] ${filename}: could not find end of get_cacert, skipping`);
    continue;
  }

  content = content.slice(0, insertPos) + "\n" + ADD_CACERT_FN + content.slice(insertPos);

  // 2. Expose add_cacert on the api object
  content = content.replace(
    "get_cacert: get_cacert,",
    "get_cacert: get_cacert,\n  add_cacert: add_cacert,"
  );

  writeFileSync(filepath, content);
  console.log(`[patch-libcurl] ${filename}: patched successfully`);
  patched++;
}

if (patched === 0) {
  console.error("[patch-libcurl] WARNING: no files were patched!");
  process.exit(1);
} else {
  console.log(`[patch-libcurl] Done, patched ${patched} file(s)`);
}
