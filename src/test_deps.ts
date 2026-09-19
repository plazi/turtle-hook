// Dependencies used only by tests. Kept out of deps.ts so that the docker
// image does not have to cache them.
// 0.5 or newer: 0.4.x evaluates the owned-subject DELETE wrongly once the
// filter's prefixes are https:// (the SELECT with the same WHERE is fine), and
// leaves the material citations behind.
export { Store } from "npm:oxigraph@0.5.11";
export {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
