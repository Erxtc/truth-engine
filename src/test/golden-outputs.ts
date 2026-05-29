/**
 * Golden expected outputs for every benchmark problem.
 *
 * These are pre-computed, human-verified test cases that serve as GROUND TRUTH.
 * The LLM-generated oracle is validated against these — if the oracle disagrees,
 * the oracle is wrong, not the golden output.
 *
 * Each entry maps a problem name to its canonical test cases.
 * These are version-controlled so regressions are visible in git.
 */

export interface GoldenTestCase {
  /** Arguments to proposedSolution(), as JSON-encodable values */
  input: unknown[];
  /** Expected return value (JSON-stringified for object/array comparison) */
  expected: unknown;
  /** Optional: tolerance for floating-point comparisons (relative) */
  tolerance?: number;
}

export interface GoldenProblem {
  name: string;
  /** Expected function signature to verify */
  paramCount: number;
  testCases: GoldenTestCase[];
}

export const GOLDEN_OUTPUTS: Record<string, GoldenProblem> = {
  // ── Trivial ──────────────────────────────────────────────────────────────────

  fibonacci: {
    name: "fibonacci",
    paramCount: 1,
    testCases: [
      { input: [0], expected: 0 },
      { input: [1], expected: 1 },
      { input: [10], expected: 55 },
      { input: [20], expected: 6765 },
    ],
  },

  "binary-search": {
    name: "binary-search",
    paramCount: 2,
    testCases: [
      { input: [[1, 3, 5, 7, 9, 11], 7], expected: 3 },
      { input: [[1, 3, 5, 7, 9, 11], 8], expected: -1 },
      { input: [[], 5], expected: -1 },
    ],
  },

  "caesar-cipher": {
    name: "caesar-cipher",
    paramCount: 3,
    testCases: [
      { input: ["HELLO", 3, "encrypt"], expected: "KHOOR" },
      { input: ["KHOOR", 3, "decrypt"], expected: "HELLO" },
      { input: ["Hello, World!", 5, "encrypt"], expected: "Mjqqt, Btwqi!" },
      { input: ["xyz", 3, "encrypt"], expected: "abc" },
    ],
  },

  "heat-transfer": {
    name: "heat-transfer",
    paramCount: 5,
    testCases: [
      { input: [100, 20, 0.04, 0.1, 2], expected: 64.0, tolerance: 0.01 },
      { input: [200, 50, 401, 0.5, 0.01], expected: 1203.0, tolerance: 0.01 },
      { input: [50, 10, 0.8, 2, 3], expected: 48.0, tolerance: 0.01 },
    ],
  },

  "ph-calculation": {
    name: "ph-calculation",
    paramCount: 1,
    testCases: [
      { input: [0.0001], expected: 4.0, tolerance: 0.01 },
      { input: [1.0e-7], expected: 7.0, tolerance: 0.01 },
      { input: [0.01], expected: 2.0, tolerance: 0.01 },
    ],
  },

  "buffer-ph": {
    name: "buffer-ph",
    paramCount: 3,
    testCases: [
      { input: [4.76, 0.1, 0.1], expected: 4.76, tolerance: 0.01 },
      { input: [4.76, 0.1, 1.0], expected: 5.76, tolerance: 0.01 },
      { input: [7.21, 0.05, 0.01], expected: 6.51, tolerance: 0.01 },
    ],
  },

  "hex-to-base64": {
    name: "hex-to-base64",
    paramCount: 1,
    testCases: [
      { input: ["68656c6c6f"], expected: "aGVsbG8=" },
      { input: ["4d"], expected: "TQ==" },
      { input: [""], expected: "" },
      { input: ["4d616e"], expected: "TWFu" },
      // "I'm killing your brain like a poisonous mushroom"
      { input: ["49276d206b696c6c696e6720796f757220627261696e206c696b65206120706f69736f6e6f7573206d757368726f6f6d"], expected: "SSdtIGtpbGxpbmcgeW91ciBicmFpbiBsaWtlIGEgcG9pc29ub3VzIG11c2hyb29t" },
    ],
  },

  // ── Simple ────────────────────────────────────────────────────────────────────

  "coin-change": {
    name: "coin-change",
    paramCount: 2,
    testCases: [
      { input: [[1, 5, 10, 25], 30], expected: 2 },
      { input: [[1, 2, 5], 11], expected: 3 },
      { input: [[2], 3], expected: -1 },
      { input: [[1], 0], expected: 0 },
    ],
  },

  "linear-2x2": {
    name: "linear-2x2",
    paramCount: 6,
    testCases: [
      { input: [1, 1, 5, 1, -1, 1], expected: [3, 2] },
      { input: [2, 3, 8, 1, 4, 9], expected: [1, 2] },
      { input: [3, -2, 4, 2, 1, 5], expected: [2, 1] },
    ],
  },

  "pkcs7-padding": {
    name: "pkcs7-padding",
    paramCount: 3,
    testCases: [
      { input: ["YELLOW SUBMARINE", 20, "pad"], expected: "YELLOW SUBMARINE\x04\x04\x04\x04" },
      { input: ["YELLOW SUBMARINE\x04\x04\x04\x04", 20, "unpad"], expected: "YELLOW SUBMARINE" },
      { input: ["ABC\x03\x03", 4, "unpad"], expected: null },
    ],
  },

  "modular-inverse": {
    name: "modular-inverse",
    paramCount: 2,
    testCases: [
      { input: [3, 11], expected: 4 },
      { input: [7, 26], expected: 15 },
      { input: [17, 3120], expected: 2753 },
      { input: [5, 21], expected: 17 },
      { input: [1, 100], expected: 1 },
    ],
  },

  "diffie-hellman": {
    name: "diffie-hellman",
    paramCount: 4,
    testCases: [
      { input: [23, 5, 6, 15], expected: [8, 19, 2] },
      { input: [37, 2, 5, 7], expected: [32, 17, 19] },
      { input: [11, 2, 3, 4], expected: [8, 5, 4] },
    ],
  },

  "cournot-duopoly": {
    name: "cournot-duopoly",
    paramCount: 4,
    testCases: [
      { input: [100, 1, 10, 10], expected: [30.0, 30.0, 40.0, 900.0, 900.0], tolerance: 0.1 },
      { input: [100, 1, 10, 20], expected: [33.33, 23.33, 43.33, 1111.11, 544.44], tolerance: 0.1 },
      { input: [50, 2, 5, 5], expected: [7.5, 7.5, 20.0, 112.5, 112.5], tolerance: 0.1 },
    ],
  },

  "stoichiometry": {
    name: "stoichiometry",
    paramCount: 4,
    testCases: [
      { input: ["2H2 + O2 -> 2H2O", 4.0, 2.0, "H2O"], expected: 36.0, tolerance: 0.1 },
      { input: ["N2 + 3H2 -> 2NH3", 28.0, 28.0, "NH3"], expected: 34.0, tolerance: 0.1 },
      { input: ["CH4 + 2O2 -> CO2 + 2H2O", 16.0, 16.0, "CO2"], expected: 44.0, tolerance: 0.1 },
    ],
  },

  "redox-half-reactions": {
    name: "redox-half-reactions",
    paramCount: 2,
    testCases: [
      { input: [["Zn2+", "Zn", 2, -0.76], ["Cu2+", "Cu", 2, 0.34]], expected: 1.10, tolerance: 0.01 },
      { input: [["Fe2+", "Fe", 2, -0.44], ["Ag+", "Ag", 1, 0.80]], expected: 1.24, tolerance: 0.01 },
      { input: [["Mg2+", "Mg", 2, -2.37], ["2H+", "H2", 2, 0.00]], expected: 2.37, tolerance: 0.01 },
    ],
  },

  "run-length-encoding": {
    name: "run-length-encoding",
    paramCount: 2,
    testCases: [
      { input: ["AAABBBCCD", "encode"], expected: "A3B3C2D1" },
      { input: ["A3B3C2D1", "decode"], expected: "AAABBBCCD" },
      { input: ["", "encode"], expected: "" },
      { input: ["", "decode"], expected: "" },
      { input: ["A10", "decode"], expected: "AAAAAAAAAA" },
    ],
  },

  // ── Medium ────────────────────────────────────────────────────────────────────

  sorting: {
    name: "sorting-js",
    paramCount: 1,
    testCases: [
      { input: [[3, 1, 2]], expected: [1, 2, 3] },
      { input: [[5, 3, 8, 1, 2]], expected: [1, 2, 3, 5, 8] },
      { input: [[]], expected: [] },
      { input: [[1]], expected: [1] },
      { input: [[2, 2, 1, 1]], expected: [1, 1, 2, 2] },
    ],
  },

  "matrix-multiply": {
    name: "matrix-multiply",
    paramCount: 2,
    testCases: [
      { input: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]], expected: [[19, 22], [43, 50]] },
      { input: [[[2, 0], [0, 2]], [[1, 2], [3, 4]]], expected: [[2, 4], [6, 8]] },
      { input: [[[1, 2, 3]], [[4], [5], [6]]], expected: [[32]] },
    ],
  },

  "bfs-shortest-path": {
    name: "bfs-shortest-path",
    paramCount: 3,
    testCases: [
      {
        input: [{ A: ["B", "C"], B: ["A", "D"], C: ["A", "D"], D: ["B", "C", "E"], E: ["D"] }, "A", "E"],
        // Either ["A","B","D","E"] or ["A","C","D","E"] — both length 4
        expected: ["A", "B", "D", "E"],
      },
      {
        input: [{ A: ["B"], B: ["A", "C"], C: ["B"] }, "A", "C"],
        expected: ["A", "B", "C"],
      },
      {
        input: [{ A: ["B"], B: ["A"], C: ["D"], D: ["C"] }, "A", "D"],
        expected: null,
      },
    ],
  },

  "valid-sudoku": {
    name: "valid-sudoku",
    paramCount: 1,
    testCases: [
      {
        input: [[
          ["5", "3", ".", ".", "7", ".", ".", ".", "."],
          ["6", ".", ".", "1", "9", "5", ".", ".", "."],
          [".", "9", "8", ".", ".", ".", ".", "6", "."],
          ["8", ".", ".", ".", "6", ".", ".", ".", "3"],
          ["4", ".", ".", "8", ".", "3", ".", ".", "1"],
          ["7", ".", ".", ".", "2", ".", ".", ".", "6"],
          [".", "6", ".", ".", ".", ".", "2", "8", "."],
          [".", ".", ".", "4", "1", "9", ".", ".", "5"],
          [".", ".", ".", ".", "8", ".", ".", "7", "9"],
        ]],
        expected: true,
      },
    ],
  },

  "sir-model": {
    name: "sir-model",
    paramCount: 6,
    testCases: [
      {
        input: [1000, 1, 0, 0.3, 0.1, 5],
        // Day 0: S=1000, I=1, R=0. Key invariant: S+I+R = N = 1001 always
        // Just verify S0, I0, R0 and conservation
        expected: { S0: 1000, I0: 1, R0: 0, N: 1001 },
        tolerance: 0.5,
      },
      {
        input: [100, 5, 0, 0.5, 0.2, 3],
        expected: { S0: 100, I0: 5, R0: 0, N: 105 },
        tolerance: 0.5,
      },
    ],
  },

  "projectile-motion": {
    name: "projectile-motion",
    paramCount: 4,
    testCases: [
      { input: [10, 45, 0, 9.8], expected: { max_height: 2.55, range: 10.2 }, tolerance: 0.2 },
      { input: [20, 30, 5, 9.8], expected: { max_height: 5.10, range: 40.3 }, tolerance: 1.0 },
    ],
  },

  "monte-carlo-pi": {
    name: "monte-carlo-pi",
    paramCount: 1,
    testCases: [
      // Seeded with 42, these are deterministic
      { input: [10000], expected: 3.14, tolerance: 0.05 },
      { input: [1], expected: null, tolerance: 0 }, // 4.0 or 0.0 — skip strict check
      { input: [0], expected: 0.0, tolerance: 0.01 },
    ],
  },

  // ── Hard ──────────────────────────────────────────────────────────────────────

  "dijkstra-shortest-path": {
    name: "dijkstra-shortest-path",
    paramCount: 3,
    testCases: [
      {
        input: [
          { A: [["B", 4], ["C", 2]], B: [["A", 4], ["D", 5]], C: [["A", 2], ["B", 1], ["D", 8], ["E", 10]], D: [["B", 5], ["C", 8], ["E", 2]], E: [["C", 10], ["D", 2]] },
          "A", "E",
        ],
        expected: { distance: 10, path: ["A", "C", "B", "D", "E"] },
      },
      {
        input: [{ A: [["B", 1]], B: [["A", 1]] }, "A", "B"],
        expected: { distance: 1, path: ["A", "B"] },
      },
      {
        input: [{ A: [["B", 1]], B: [["A", 1]], C: [["D", 1]], D: [["C", 1]] }, "A", "D"],
        expected: { distance: null, path: null },
      },
    ],
  },

  "edit-distance": {
    name: "edit-distance",
    paramCount: 2,
    testCases: [
      { input: ["kitten", "sitting"], expected: 3 },
      { input: ["sunday", "saturday"], expected: 3 },
      { input: ["abc", "abc"], expected: 0 },
      { input: ["", "hello"], expected: 5 },
    ],
  },

  "LIS": {
    name: "LIS",
    paramCount: 1,
    testCases: [
      { input: [[10, 9, 2, 5, 3, 7, 101, 18]], expected: 4 },
      { input: [[0, 1, 0, 3, 2, 3]], expected: 4 },
      { input: [[7, 7, 7, 7, 7, 7, 7]], expected: 1 },
    ],
  },

  "topological-sort": {
    name: "topological-sort",
    paramCount: 1,
    testCases: [
      { input: [{ A: ["B", "C"], B: ["D"], C: ["D"], D: [] }], expected: null }, // any valid order
    ],
  },

  "nash-equilibrium": {
    name: "nash-equilibrium",
    paramCount: 1,
    testCases: [
      { input: [[[[3, 3], [0, 5]], [[5, 0], [1, 1]]]], expected: [[1, 1]] },
      { input: [[[[2, 1], [0, 0]], [[0, 0], [1, 2]]]], expected: [[0, 0], [1, 1]] },
      { input: [[[[1, -1], [-1, 1]], [[-1, 1], [1, -1]]]], expected: [] },
    ],
  },

  "gillespie-sir": {
    name: "gillespie-sir",
    paramCount: 6,
    testCases: [
      { input: [100, 1, 0, 0.01, 0.1, 10], expected: "deterministic-seeded" },
      { input: [50, 5, 0, 0.02, 0.1, 5], expected: "deterministic-seeded" },
    ],
  },

  "n-queens": {
    name: "n-queens",
    paramCount: 1,
    testCases: [
      { input: [4], expected: null }, // any valid config — oracle checks
      { input: [1], expected: [0] },
    ],
  },

  "aes-cbc-decrypt": {
    name: "aes-cbc-decrypt",
    paramCount: 3,
    testCases: [
      {
        input: ["7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b273bed6b8e3c1743b7116e69e222295163ff1caa1681fac09120eca307586e1a7", "2b7e151628aed2a6abf7158809cf4f3c", "000102030405060708090a0b0c0d0e0f"],
        expected: "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710",
      },
      {
        input: ["6cd03227ae26f9b3cfa02e3dcb30b6e3", "2b7e151628aed2a6abf7158809cf4f3c", "000102030405060708090a0b0c0d0e0f"],
        expected: "48656c6c6f576f726c64",
      },
    ],
  },

  "lru-cache": {
    name: "lru-cache",
    paramCount: 2,
    testCases: [
      {
        input: [2, [["put", 1, 10], ["put", 2, 20], ["get", 1], ["put", 3, 30], ["get", 2], ["get", 3]]],
        expected: [null, null, 10, null, -1, 30],
      },
      {
        input: [1, [["put", 1, 100], ["get", 1], ["put", 2, 200], ["get", 1], ["get", 2]]],
        expected: [null, 100, null, -1, 200],
      },
      {
        input: [3, [["put", 1, 10], ["put", 2, 20], ["put", 1, 100], ["get", 1], ["get", 2]]],
        expected: [null, null, null, 100, 20],
      },
    ],
  },

  "kmp-string-search": {
    name: "kmp-string-search",
    paramCount: 2,
    testCases: [
      { input: ["ABABDABACDABABCABAB", "ABABCABAB"], expected: [10] },
      { input: ["AAAAA", "AA"], expected: [0, 1, 2, 3] },
      { input: ["HELLO WORLD", "ABC"], expected: [] },
      { input: ["ABCABCABC", "ABCABC"], expected: [0, 3] },
    ],
  },

  "bellman-ford": {
    name: "bellman-ford",
    paramCount: 2,
    testCases: [
      {
        input: [[["A", "B", 4], ["A", "C", 2], ["B", "C", -3], ["B", "D", 2], ["C", "D", 3]], "A"],
        expected: { distances: { A: 0, B: 4, C: 1, D: 4 }, has_negative_cycle: false },
      },
      {
        input: [[["A", "B", 1], ["B", "C", -2], ["C", "A", -1]], "A"],
        expected: { has_negative_cycle: true },
      },
    ],
  },

  "convex-hull": {
    name: "convex-hull",
    paramCount: 1,
    testCases: [
      { input: [[[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]], expected: null }, // hull = [(0,0),(1,0),(1,1),(0,1)]
      { input: [[[0, 0], [1, 1], [2, 2]]], expected: null }, // collinear — endpoints only
    ],
  },

  "rsa-keygen": {
    name: "rsa-keygen",
    paramCount: 3,
    testCases: [
      {
        input: [61, 53, 17],
        expected: { n: 3233, phi: 3120, e: 17, d: 2753, public_key: [3233, 17], private_key: [3233, 2753] },
      },
    ],
  },

  "glycolysis-model": {
    name: "glycolysis-model",
    paramCount: 3,
    testCases: [
      {
        input: [1, 0, "aerobic"],
        expected: { total_atp: 6.3, from_glycolysis: 2.0, from_nadh: 5.0, overhead_consumed: 0.7, conservation_ok: true, saturation_applied: false },
        tolerance: 0.1,
      },
      {
        input: [1, 0, "anaerobic"],
        expected: { total_atp: 1.8, from_glycolysis: 2.0, from_nadh: 0.0, overhead_consumed: 0.2, conservation_ok: true, saturation_applied: false },
        tolerance: 0.1,
      },
    ],
  },

  "a-star-pathfinding": {
    name: "a-star-pathfinding",
    paramCount: 3,
    testCases: [
      { input: [["....", ".##.", "....", "...."], [0, 0], [3, 3]], expected: 7 }, // path length
      { input: [["....", "####", "....", "...."], [0, 0], [2, 0]], expected: null },
    ],
  },

  "huffman-coding": {
    name: "huffman-coding",
    paramCount: 1,
    testCases: [
      { input: ["aab"], expected: { encoded_length: 3 } },
      { input: ["aaaabbbcc"], expected: { encoded_length: 14 } },
      { input: [""], expected: { encoded_length: 0 } },
    ],
  },

  "max-flow-edmonds-karp": {
    name: "max-flow-edmonds-karp",
    paramCount: 3,
    testCases: [
      { input: [{ S: [["A", 10], ["B", 5]], A: [["T", 10]], B: [["A", 15], ["T", 5]], T: [] }, "S", "T"], expected: 15 },
      { input: [{ S: [["A", 3], ["B", 2]], A: [["B", 1], ["T", 2]], B: [["T", 3]], T: [] }, "S", "T"], expected: 5 },
      { input: [{ S: [["A", 5]], A: [], T: [] }, "S", "T"], expected: 0 },
    ],
  },

  "recursive-descent-parser": {
    name: "recursive-descent-parser",
    paramCount: 1,
    testCases: [
      { input: ["3 + 5"], expected: 8 },
      { input: ["3 + 5 * 2"], expected: 13 },
      { input: ["(3 + 5) * 2"], expected: 16 },
      { input: ["-3 + 5"], expected: 2 },
      { input: ["3 + 4 * 2 / (1 - 5)"], expected: 1 },
      { input: ["10 / 3"], expected: 3 },
      { input: ["2 * (3 + 4 * (5 - 2))"], expected: 30 },
    ],
  },

  "neural-network-xor": {
    name: "neural-network-xor",
    paramCount: 1,
    testCases: [
      { input: [[[0, 0], [0, 1], [1, 0], [1, 1]]], expected: [0, 1, 1, 0] },
      { input: [[[0, 0]]], expected: [0] },
      { input: [[[1, 1], [0, 0]]], expected: [0, 0] },
    ],
  },

  // ── Very Hard ─────────────────────────────────────────────────────────────────

  "avl-tree": {
    name: "avl-tree",
    paramCount: 1,
    testCases: [
      { input: [[["insert", 10], ["insert", 20], ["insert", 30]]], expected: [10, 20, 20] },
      { input: [[["insert", 30], ["insert", 20], ["insert", 10]]], expected: [30, 30, 20] },
      { input: [[["insert", 10], ["insert", 20], ["search", 10], ["search", 30]]], expected: [10, 10, true, false] },
    ],
  },

  "sha256": {
    name: "sha256",
    paramCount: 1,
    testCases: [
      { input: [""], expected: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
      { input: ["hello"], expected: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
      { input: ["abc"], expected: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
      { input: ["The quick brown fox jumps over the lazy dog"], expected: "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592" },
    ],
  },

  "nbody-simulation": {
    name: "nbody-simulation",
    paramCount: 3,
    testCases: [
      {
        input: [[{ mass: 1e14, x: 0, y: 0, vx: 0, vy: 0 }], 0.1, 5],
        // Single body: stays at origin for all 6 frames
        expected: "stationary-single-body",
      },
    ],
  },

  // ── Project/CLI (tested via projectTests) ──────────────────────────────────────

  "word-count-cli": {
    name: "word-count-cli",
    paramCount: 0,
    testCases: [],
  },

  "csv-stats": {
    name: "csv-stats",
    paramCount: 0,
    testCases: [],
  },

  "weather-cli": {
    name: "weather-cli",
    paramCount: 0,
    testCases: [],
  },

  "crypto-stats": {
    name: "crypto-stats",
    paramCount: 0,
    testCases: [],
  },

  // ── Trie ──────────────────────────────────────────────────────────────────────

  "trie-autocomplete": {
    name: "trie-autocomplete",
    paramCount: 1,
    testCases: [
      { input: [[["insert", "apple"], ["search", "apple"], ["search", "app"], ["startsWith", "app"], ["insert", "app"], ["search", "app"]]], expected: [null, true, false, true, null, true] },
      { input: [[["insert", "bat"], ["insert", "ball"], ["insert", "bark"], ["autocomplete", "ba"]]], expected: [null, null, null, ["ball", "bark"]] },
      { input: [[["search", ""], ["startsWith", ""], ["autocomplete", "never"]]], expected: [false, false, []] },
    ],
  },

  // ── Gaussian elimination ──────────────────────────────────────────────────────

  "gaussian-elimination": {
    name: "gaussian-elimination",
    paramCount: 2,
    testCases: [
      { input: [[[2, 1], [1, -1]], [5, 1]], expected: [2, 1], tolerance: 0.01 },
      { input: [[[3, 2], [1, 4]], [7, 9]], expected: [1, 2], tolerance: 0.01 },
    ],
  },
};
