// Dependencies used only by tests. Kept out of deps.ts so that the docker
// image does not have to cache them.
export { Store } from "npm:oxigraph@0.4.11";
export {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
