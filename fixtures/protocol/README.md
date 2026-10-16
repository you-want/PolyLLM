/**
 * @fileoverview Fixture case format used by both TS and Python runners.
 *
 * Each case in fixtures/protocol/*.json is one of:
 *  - a request case:   { id, valid, request, expectations? }
 *  - a response case:  { id, valid, response, expectations? }
 *  - a stream case:    { id, valid, wire, raw, expectedChunks, error? }
 *  - a mixed case:     { id, valid, request, response, expectations }
 *
 * Validation target is selected by which key is present:
 *  - request  -> schemas/unified-request.json
 *  - response -> schemas/unified-response.json
 *  - raw      -> no schema; wire-protocol parse only (the TS/Python runners
 *                 own these; a fixture marked `valid: false` with a `raw`
 *                 key is verified by the runner, not by the JSON Schema)
 *
 * `valid: false` means the case is expected to fail schema validation or
 * wire-protocol parsing. The specific expected error category goes in
 * `error.category` where applicable (stream/parse cases) or in
 * `expectations.category` (request/response cases).
 *
 * Schema validation of conditional rules (if/then, allOf) is currently
 * not exercised by the lightweight local validator; those cases must
 * also be covered by the two runners' own schema validators (M3 adds a
 * full JSON-Schema validator to `scripts/verify-protocol.mjs`).
 */

/**
 * @typedef {Object} FixtureCase
 * @property {string} id
 * @property {boolean} valid
 * @property {Object} [request]
 * @property {Object} [response]
 * @property {string} [wire]
 * @property {string} [raw]
 * @property {Array} [expectedChunks]
 * @property {Object} [error]
 * @property {Object} [expectations]
 */
