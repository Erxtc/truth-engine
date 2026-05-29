/**
 * Benchmark problem definitions — extracted from benchmark.ts so the runner
 * stays focused on orchestration and reporting.
 *
 * To add a problem: append a TestProblem object to the PROBLEMS array below.
 */
export type Complexity = "trivial" | "simple" | "medium" | "hard" | "very-hard";

export interface ProjectTest {
  /** Shell command to run (e.g. "python3 main.py input.txt") */
  command: string;
  /** Expected substring in combined stdout+stderr (case-insensitive match) */
  expectedOutput?: string;
  /** Expected exit code (default: 0) */
  expectedExitCode?: number;
  /** Input content to pipe to stdin */
  stdin?: string;
  /** Setup: write this file content before running tests */
  setupFiles?: Record<string, string>;
}

export interface TestProblem {
  name: string;
  description: string;
  /** "python" or "js" — which language the solution should be in */
  language: "python" | "js";
  /** If set, use a registered domain instead of auto-detect */
  domain?: string;
  /** Problem complexity — guides which tier to target next */
  complexity: Complexity;
  /** For project/CLI domains: functional tests that verify correctness.
   *  Written as tests.json in the task-agent sandbox so the verify script
   *  can run them. Without this, project verification is structural only. */
  projectTests?: ProjectTest[];
}

export const PROBLEMS: TestProblem[] = [
  // ── Reference problems (proven solvable) ────────────────────────────────────
  {
    name: "fibonacci",
    description: "Write proposedSolution(n) returning the nth Fibonacci number (fib(0)=0, fib(1)=1). n is a non-negative integer.",
    language: "python",
    complexity: "trivial",
  },
  {
    name: "sorting-js",
    description: "Write proposedSolution(arr) that sorts an array of integers in ascending order. Must be a valid JavaScript function. Do NOT use the built-in Array.prototype.sort().",
    language: "js",
    domain: "auto",
    complexity: "medium",
  },
  // ── Linear systems ──────────────────────────────────────────────────────────
  {
    name: "linear-2x2",
    description: `Write proposedSolution(a1,b1,c1, a2,b2,c2) that solves the 2x2 linear system using Cramer's rule. Return a tuple (x, y). Assume unique solution (det ≠ 0).

Example 1: proposedSolution(1, 1, 5, 1, -1, 1) → (3, 2) because x+y=5, x-y=1
Example 2: proposedSolution(2, 3, 8, 1, 4, 9) → (1, 2) because 2x+3y=8, x+4y=9
Example 3: proposedSolution(3, -2, 4, 2, 1, 5) → (2, 1) because 3x-2y=4, 2x+y=5`,
    language: "python",
    complexity: "simple",
  },
  {
    name: "matrix-multiply",
    description: `Write proposedSolution(A, B) that multiplies two matrices A (m×n) and B (n×p). Return the m×p result as list of lists.

Example 1: proposedSolution([[1,2],[3,4]], [[5,6],[7,8]]) → [[19,22],[43,50]]
Example 2: proposedSolution([[2,0],[0,2]], [[1,2],[3,4]]) → [[2,4],[6,8]]
Example 3: proposedSolution([[1,2,3]], [[4],[5],[6]]) → [[32]]`,
    language: "python",
    complexity: "medium",
  },
  {
    name: "gaussian-elimination",
    description: `Write proposedSolution(A, b) that solves Ax=b using Gaussian elimination with partial pivoting. A is n×n (list of lists), b is list of length n. Return solution x as list.

Example 1: proposedSolution([[2,1],[1,-1]], [5,1]) → [2, 1] because 2x+y=5, x-y=1
Example 2: proposedSolution([[3,2],[1,4]], [7,9]) → [1, 2] because 3x+2y=7, x+4y=9
Example 3: proposedSolution([[1,2,3],[2,3,1],[3,1,2]], [14,11,11]) → [1, 2, 3]`,
    language: "python",
    complexity: "hard",
  },
  // ── Graph algorithms ────────────────────────────────────────────────────────
  {
    name: "bfs-shortest-path",
    description: `Write proposedSolution(graph, start, target) that finds the shortest path from start to target using BFS. graph is an adjacency list (dict of node → list of neighbors). Return the path as a list of nodes [start, ..., target], or None if no path exists. All edges have weight 1.

Example 1: proposedSolution({"A":["B","C"], "B":["A","D"], "C":["A","D"], "D":["B","C","E"], "E":["D"]}, "A", "E") → ["A", "C", "D", "E"] or ["A", "B", "D", "E"] (either works, both length 3)
Example 2: proposedSolution({"A":["B"], "B":["A","C"], "C":["B"]}, "A", "C") → ["A", "B", "C"]
Example 3: proposedSolution({"A":["B"], "B":["A"], "C":["D"], "D":["C"]}, "A", "D") → None`,
    language: "python",
    complexity: "medium",
  },
  {
    name: "dijkstra-shortest-path",
    description: `Write proposedSolution(graph, start, target) implementing Dijkstra's shortest path algorithm. graph is a dict mapping node → list of (neighbor, weight) tuples. All weights are non-negative. Return (distance, path) where distance is the shortest distance, and path is the list of nodes [start, ..., target]. If no path exists, return (None, None).

Example 1: proposedSolution({"A":[("B",4),("C",2)], "B":[("A",4),("D",5)], "C":[("A",2),("B",1),("D",8),("E",10)], "D":[("B",5),("C",8),("E",2)], "E":[("C",10),("D",2)]}, "A", "E") → (10, ["A", "C", "B", "D", "E"])
Example 2: proposedSolution({"A":[("B",1)], "B":[("A",1)]}, "A", "B") → (1, ["A", "B"])
Example 3: proposedSolution({"A":[("B",1)], "B":[("A",1)], "C":[("D",1)], "D":[("C",1)]}, "A", "D") → (None, None)`,
    language: "python",
    complexity: "hard",
  },
  {
    name: "topological-sort",
    description: `Write proposedSolution(graph) that performs topological sort on a DAG using Kahn's algorithm. graph is a dict of node → list of neighbors. Return list of nodes in topological order. Assume graph is a valid DAG (no cycles).

Example 1: proposedSolution({"A":["B","C"], "B":["D"], "C":["D"], "D":[]}) → ["A", "B", "C", "D"] or ["A", "C", "B", "D"]
Example 2: proposedSolution({"5":["2","0"], "4":["0","1"], "2":["3"], "3":["1"], "1":[], "0":[]}) → Any valid topological order
Example 3: proposedSolution({"A":[], "B":[], "C":[]}) → Any permutation of A, B, C`,
    language: "python",
    complexity: "hard",
  },
  // ── Dynamic programming ─────────────────────────────────────────────────────
  {
    name: "coin-change",
    description: `Write proposedSolution(coins, amount) that finds the fewest number of coins needed to make up that amount using dynamic programming. coins is a list of positive integers (unlimited supply of each). Return the minimum number of coins, or -1 if the amount cannot be made.

Example 1: proposedSolution([1, 5, 10, 25], 30) → 2 (25+5)
Example 2: proposedSolution([1, 2, 5], 11) → 3 (5+5+1 or 5+2+2+2 → 3 is minimum)
Example 3: proposedSolution([2], 3) → -1 (can't make 3 with only 2s)
Example 4: proposedSolution([1], 0) → 0`,
    language: "python",
    complexity: "simple",
  },
  {
    name: "edit-distance",
    description: `Write proposedSolution(s1, s2) computing the Levenshtein edit distance between two strings. Allowed operations: insert, delete, substitute (each cost 1). Use the Wagner-Fischer DP algorithm. Return integer distance.

Example 1: proposedSolution("kitten", "sitting") → 3 (k→s, e→i, +g)
Example 2: proposedSolution("sunday", "saturday") → 3
Example 3: proposedSolution("abc", "abc") → 0
Example 4: proposedSolution("", "hello") → 5`,
    language: "python",
    complexity: "hard",
  },
  {
    name: "LIS",
    description: `Write proposedSolution(arr) that finds the length of the longest increasing subsequence using patience sorting (O(n log n)). Return the length (integer).

Example 1: proposedSolution([10, 9, 2, 5, 3, 7, 101, 18]) → 4 ([2, 3, 7, 101] or [2, 5, 7, 101])
Example 2: proposedSolution([0, 1, 0, 3, 2, 3]) → 4 ([0, 1, 2, 3])
Example 3: proposedSolution([7, 7, 7, 7, 7, 7, 7]) → 1`,
    language: "python",
    complexity: "hard",
  },
  // ── Cryptography ────────────────────────────────────────────────────────────
  {
    name: "caesar-cipher",
    description: `Write proposedSolution(text, shift, mode) implementing the Caesar cipher. text is a string. shift is an integer (0-25). mode is "encrypt" (shift forward) or "decrypt" (shift backward). Preserve case and skip non-letter characters. Return the result string.

Example 1: proposedSolution("HELLO", 3, "encrypt") → "KHOOR"
Example 2: proposedSolution("KHOOR", 3, "decrypt") → "HELLO"
Example 3: proposedSolution("Hello, World!", 5, "encrypt") → "Mjqqt, Btwqi!"
Example 4: proposedSolution("xyz", 3, "encrypt") → "abc" (wraps around)`,
    language: "python",
    complexity: "trivial",
  },
  {
    name: "binary-search",
    description: `Write proposedSolution(arr, target) that performs binary search on a sorted array. arr is sorted in ascending order. Return the index of target, or -1 if not found. Must be O(log n). Iterative or recursive, either is fine.

Example 1: proposedSolution([1, 3, 5, 7, 9, 11], 7) → 3
Example 2: proposedSolution([1, 3, 5, 7, 9, 11], 8) → -1
Example 3: proposedSolution([], 5) → -1`,
    language: "python",
    complexity: "trivial",
  },
  {
    name: "valid-sudoku",
    description: `Write proposedSolution(board) that checks if a partially filled 9x9 Sudoku board is valid. Board is a list of 9 lists of 9 chars each. Empty cells are ".". Valid means: no duplicate digits 1-9 in any row, column, or 3x3 sub-box. Return True if valid, False otherwise. Note: a valid board doesn't need to be solvable, just have no conflicts.

Example 1: proposedSolution([
["5","3",".",".","7",".",".",".","."],
["6",".",".","1","9","5",".",".","."],
[".","9","8",".",".",".",".","6","."],
["8",".",".",".","6",".",".",".","3"],
["4",".",".","8",".","3",".",".","1"],
["7",".",".",".","2",".",".",".","6"],
[".","6",".",".",".",".","2","8","."],
[".",".",".","4","1","9",".",".","5"],
[".",".",".",".","8",".",".","7","9"]]) → True

Example 2: Same as above but change top-left 5→8 (two 8s in first box) → False`,
    language: "python",
    complexity: "medium",
  },
  // ── N-Queens ────────────────────────────────────────────────────────────────
  {
    name: "n-queens",
    description: `Write proposedSolution(n) that returns one valid solution to the N-Queens problem using backtracking. Return a list of n integers where the value at index i is the column position of the queen in row i. If no solution exists, return [].

Example 1: proposedSolution(4) → [1, 3, 0, 2] (.Q../...Q/Q.../..Q.) or [2, 0, 3, 1]
Example 2: proposedSolution(1) → [0]
Example 3: proposedSolution(8) → Any valid 8-queens configuration as 8 integers 0-7`,
    language: "python",
    complexity: "very-hard",
  },
  // ── Scientific ──────────────────────────────────────────────────────────────
  {
    name: "heat-transfer",
    description: `Write proposedSolution(T_hot, T_cold, k, L, A) that calculates the steady-state heat transfer rate Q through a flat wall using Fourier's law: Q = k * A * (T_hot - T_cold) / L. All inputs are positive floats. Return Q as a float (no units required).

Example 1: proposedSolution(100, 20, 0.04, 0.1, 2) → 64.0 (k=0.04 W/mK brick, L=0.1m, A=2m², ΔT=80K: Q = 0.04*2*80/0.1 = 64)
Example 2: proposedSolution(200, 50, 401, 0.5, 0.01) → 1203.0 (k=401 copper, L=0.5m, A=0.01m², ΔT=150K)
Example 3: proposedSolution(50, 10, 0.8, 2, 3) → 48.0`,
    language: "python",
    complexity: "trivial",
  },
  {
    name: "ph-calculation",
    description: `Write proposedSolution(h_concentration) that calculates pH from hydrogen ion concentration: pH = -log10([H+]). h_concentration is a positive float (mol/L). Return pH rounded to 2 decimal places.

Example 1: proposedSolution(0.0001) → 4.0 (pH of 1e-4 M HCl = 4.0)
Example 2: proposedSolution(1.0e-7) → 7.0 (pure water)
Example 3: proposedSolution(0.01) → 2.0`,
    language: "python",
    complexity: "trivial",
  },
  {
    name: "buffer-ph",
    description: `Write proposedSolution(pKa, c_acid, c_base) that calculates the pH of a buffer solution using the Henderson-Hasselbalch equation: pH = pKa + log10([A-]/[HA]). c_acid is [HA] concentration, c_base is [A-] concentration (both positive floats, mol/L). Return pH rounded to 2 decimal places.

Example 1: proposedSolution(4.76, 0.1, 0.1) → 4.76 (acetic acid/acetate, equal conc)
Example 2: proposedSolution(4.76, 0.1, 1.0) → 5.76 (10x more base → pH = 4.76 + 1.0 = 5.76)
Example 3: proposedSolution(7.21, 0.05, 0.01) → 6.51`,
    language: "python",
    complexity: "trivial",
  },
  {
    name: "redox-half-reactions",
    description: `Write proposedSolution(half1, half2) that takes two half-reaction tuples and returns the cell potential E_cell in volts. Each tuple is (species, reduced_form, electrons, E0). The half with the higher (more positive) E0 is the cathode (reduction); the lower E0 is the anode (oxidation). E_cell = E0_cathode - E0_anode.

Example 1: proposedSolution(("Zn2+", "Zn", 2, -0.76), ("Cu2+", "Cu", 2, 0.34)) → 1.10 (Cu E0=0.34 is cathode, Zn E0=-0.76 is anode: 0.34 - (-0.76) = 1.10)
Example 2: proposedSolution(("Fe2+", "Fe", 2, -0.44), ("Ag+", "Ag", 1, 0.80)) → 1.24 (Ag E0=0.80 is cathode, Fe E0=-0.44 is anode: 0.80 - (-0.44) = 1.24)
Example 3: proposedSolution(("Mg2+", "Mg", 2, -2.37), ("2H+", "H2", 2, 0.00)) → 2.37 (H E0=0.00 is cathode, Mg E0=-2.37 is anode: 0.00 - (-2.37) = 2.37)`,
    language: "python",
    complexity: "simple",
  },
  {
    name: "stoichiometry",
    description: `Write proposedSolution(balanced_eq, mass_given, molar_mass_given, target_species) that calculates the mass of a target species from a balanced chemical equation and given mass. The equation is a string like "2H2 + O2 -> 2H2O". mass_given is the mass in grams of the first reactant. molar_mass_given is g/mol of the first reactant. target_species is the name of the product whose mass to calculate (e.g., "H2O"). Return mass in grams rounded to 2 decimal places.

Example 1: proposedSolution("2H2 + O2 -> 2H2O", 4.0, 2.0, "H2O") → 36.0 (4g H2 = 2 mol H2 → 2 mol H2O * 18 g/mol = 36g H2O)
Example 2: proposedSolution("N2 + 3H2 -> 2NH3", 28.0, 28.0, "NH3") → 34.0 (1 mol N2 → 2 mol NH3 * 17 = 34)
Example 3: proposedSolution("CH4 + 2O2 -> CO2 + 2H2O", 16.0, 16.0, "CO2") → 44.0 (1 mol CH4 → 1 mol CO2 * 44 = 44g)`,
    language: "python",
    complexity: "simple",
  },
  {
    name: "glycolysis-model",
    description: `Write proposedSolution(glucose_mmol, atp_existing_mmol, mode) that models glycolysis ATP yield: 1 glucose → 2 ATP (net) + 2 NADH. Under aerobic conditions, 2 NADH → ~5 ATP (oxidative phosphorylation), total theoretical cap = 7 ATP per glucose. Under anaerobic, NADH not converted to ATP, so 2 ATP per glucose. After 10 glucose molecules processed, enzyme saturation reduces net yield to 1.5 ATP/glucose. ATP regeneration consumes some produced ATP (10% overhead). ATP is never destroyed — conservation check validates input + produced = existing + new_output.

Input: glucose_mmol (float, mmol of glucose available), atp_existing_mmol (float, mmol of ATP already present), mode ("aerobic" or "anaerobic").
Return: {"total_atp": ..., "from_glycolysis": ..., "from_nadh": ..., "overhead_consumed": ..., "conservation_ok": bool, "saturation_applied": bool}

Example 1: proposedSolution(1, 0, "aerobic") → {"total_atp": 6.3, "from_glycolysis": 2.0, "from_nadh": 5.0, "overhead_consumed": 0.7, "conservation_ok": true, "saturation_applied": false}
Example 2: proposedSolution(1, 0, "anaerobic") → {"total_atp": 1.8, "from_glycolysis": 2.0, "from_nadh": 0.0, "overhead_consumed": 0.2, "conservation_ok": true, "saturation_applied": false}
Example 3: proposedSolution(15, 10, "aerobic") → saturation applied (15 > 10 threshold), lower per-glucose yield, conservation_ok: true`,
    language: "python",
    complexity: "hard",
  },
  {
    name: "sir-model",
    description: `Write proposedSolution(S0, I0, R0, beta, gamma, days) that runs a deterministic SIR compartmental model. Use Euler integration with daily time steps (Δt = 1). The SIR differential equations are:

dS/dt = -β * S * I / N
dI/dt = β * S * I / N - γ * I
dR/dt = γ * I

where N = S + I + R is the total population (N stays constant). Using Euler integration:

S_next = S - β * S * I / N
I_next = I + β * S * I / N - γ * I
R_next = R + γ * I

Return a dict with keys "S", "I", "R" — each is a list of length days+1 with the daily compartment values (doubles). Round all values to 1 decimal place.

Example 1: proposedSolution(1000, 1, 0, 0.3, 0.1, 5) → day 0: 1000/1/0; day 1: S=999.7, I=1.1, R=0.1; etc.
Example 2: proposedSolution(100, 5, 0, 0.5, 0.2, 3)`,
    language: "python",
    complexity: "medium",
  },
  {
    name: "gillespie-sir",
    description: `Write proposedSolution(S0, I0, R0, beta, gamma, t_max) implementing the Gillespie algorithm (stochastic simulation algorithm) for the SIR model with infection rate beta*S*I and recovery rate gamma*I. Return dict with keys "t" (event times list) and "S", "I", "R" (compartment values at each event time). Initial state at t=0 must be included as the first entry. Seed the random number generator with 42 at the start to make results reproducible.

Example 1: proposedSolution(100, 1, 0, 0.01, 0.1, 10) — Return compartments at every event until t > 10
Example 2: proposedSolution(50, 5, 0, 0.02, 0.1, 5)`,
    language: "python",
    complexity: "hard",
  },
  {
    name: "projectile-motion",
    description: `Write proposedSolution(v0, angle_degrees, h0, g) computing the trajectory of a projectile. Return a dict with: "max_height" (float), "range" (float, horizontal distance when hitting ground at y=h0), "time_of_flight" (float), "trajectory" (list of (x, y) tuples at 20 evenly-spaced time points from t=0 to time_of_flight). Assume flat ground at height h0, initial height h0 above ground, launch angle in degrees. Use simple kinematic equations (no air resistance).

Example 1: proposedSolution(10, 45, 0, 9.8) → max_height ~2.55m (h0=0 ground), range ~10.2m, time ~1.44s
Example 2: proposedSolution(20, 30, 5, 9.8) → launches from 5m above ground, hits ground below launch height`,
    language: "python",
    complexity: "hard",
  },
  {
    name: "cournot-duopoly",
    description: `Write proposedSolution(a, b, c1, c2) that solves a Cournot duopoly. Market demand: P = a - b*Q where Q = q1 + q2. Firm i's cost: C_i = c_i * q_i. Firm i maximizes π_i = P*q_i - c_i*q_i taking q_j as given. Solve the system of FOCs for q1, q2. Return tuple (q1, q2, P, π1, π2). All values to 2 decimal places. Input constraints: a, b > 0, c1, c2 ≥ 0, a > max(c1, c2).

Example 1: proposedSolution(100, 1, 10, 10) → (30.0, 30.0, 40.0, 900.0, 900.0) (symmetric: q_i = (a-c)/(3b) = 30, P = a - 2bq = 40, π = 900)
Example 2: proposedSolution(100, 1, 10, 20) → (33.33, 23.33, 43.33, 1111.11, 544.44)
Example 3: proposedSolution(50, 2, 5, 5) → (7.5, 7.5, 20.0, 112.5, 112.5)`,
    language: "python",
    complexity: "simple",
  },
  {
    name: "nash-equilibrium",
    description: `Write proposedSolution(payoff_matrix) that finds all pure-strategy Nash equilibria in a 2-player normal-form game. Input: 2D list payoff_matrix[row][col] = (payoff_row, payoff_col) where row player has m strategies and col player has n strategies. A Nash equilibrium is a cell where the row player can't improve by switching rows (current payoff ≥ all other payoffs in that column) AND the col player can't improve by switching columns (current payoff ≥ all other payoffs in that row). Return list of (row_idx, col_idx) tuples for all Nash equilibria. If there are no pure Nash equilibria, return [].

Example 1: proposedSolution([[(3,3), (0,5)], [(5,0), (1,1)]]) → [(1,1)] (Prisoner's Dilemma — defection is the unique Nash equilibrium)
Example 2: proposedSolution([[(2,1), (0,0)], [(0,0), (1,2)]]) → [(0,0), (1,1)] (Battle of the Sexes — two pure NE)
Example 3: proposedSolution([[(1,-1), (-1,1)], [(-1,1), (1,-1)]]) → [] (Matching Pennies — zero-sum, no pure NE)`,
    language: "python",
    complexity: "hard",
  },
  // ── PKCS#7 padding ──────────────────────────────────────────────────────────
  {
    name: "pkcs7-padding",
    description: `Write proposedSolution(data, block_size, mode) that adds ("pad") or removes ("unpad") PKCS#7 padding. data is either a bytes input (already decoded for pad mode, to be unpadded for unpad mode) as a string where each character represents a byte value (0-255). Use Python's ord() and chr() to access byte values. mode is either "pad" or "unpad". Return the padded/unpadded string. Return None if unpadding fails.

Example 1: proposedSolution("YELLOW SUBMARINE", 20, "pad") → "YELLOW SUBMARINE\\x04\\x04\\x04\\x04"
Example 2: proposedSolution("YELLOW SUBMARINE", 16, "pad") → "YELLOW SUBMARINE\\x10\\x10\\x10\\x10\\x10\\x10\\x10\\x10\\x10\\x10\\x10\\x10\\x10\\x10\\x10\\x10"
Example 3: proposedSolution("YELLOW SUBMARINE\\x04\\x04\\x04\\x04", 20, "unpad") → "YELLOW SUBMARINE"
Example 4: proposedSolution("ABC\\x03\\x03", 4, "unpad") → None`,
    language: "python",
    complexity: "simple",
  },
  {
    name: "hex-to-base64",
    description: `Write proposedSolution(hex_string) that converts a hex-encoded string to base64 encoding. hex_string is a string of hex characters (0-9, a-f, lowercase). Return the base64-encoded string.

Base64 encoding: group bits into 6-bit chunks, each chunk maps to a character from A-Za-z0-9+/ (0-25=A-Z, 26-51=a-z, 52-61=0-9, 62=+, 63=/). Pad with = so the output length is a multiple of 4. Do NOT use base64 or binascii stdlib modules — implement the algorithm.

Example 1: proposedSolution("49276d206b696c6c696e6720796f757220627261696e206c696b65206120706f69736f6e6f7573206d757368726f6f6d") → "SSdtIGtpbGxpbmcgeW91ciBicmFpbiBsaWtlIGEgcG9pc29ub3VzIG11c2hyb29t"
Example 2: proposedSolution("68656c6c6f") → "aGVsbG8="
Example 3: proposedSolution("4d") → "TQ=="
Example 4: proposedSolution("") → ""
Example 5: proposedSolution("4d616e") → "TWFu"`,
    language: "python",
    complexity: "trivial",
  },
  {
    name: "modular-inverse",
    description: `Write proposedSolution(a, m) that computes the modular multiplicative inverse of a modulo m using the Extended Euclidean Algorithm. Return x such that (a * x) % m == 1. a and m are positive integers with gcd(a, m) == 1. Result x is in range [1, m-1].

Example 1: proposedSolution(3, 11) → 4 (3*4=12, 12%11=1)
Example 2: proposedSolution(7, 26) → 15 (7*15=105, 105%26=1)
Example 3: proposedSolution(17, 3120) → 2753
Example 4: proposedSolution(5, 21) → 17 (5*17=85, 85%21=1)
Example 5: proposedSolution(1, 100) → 1`,
    language: "python",
    complexity: "simple",
  },
  {
    name: "diffie-hellman",
    description: `Write proposedSolution(p, g, a_private, b_private) that simulates Diffie-Hellman key exchange. Compute A = g^a_private mod p, B = g^b_private mod p, and the shared secret = B^a_private mod p (which equals A^b_private mod p). Return a tuple (A, B, shared_secret). Use modular exponentiation (pow(base, exp, mod) in Python).

Example 1: proposedSolution(23, 5, 6, 15) → (8, 19, 2)
Example 2: proposedSolution(37, 2, 5, 7) → (32, 17, 19)
Example 3: proposedSolution(11, 2, 3, 4) → (8, 5, 4)`,
    language: "python",
    complexity: "simple",
  },
  {
    name: "aes-cbc-decrypt",
    description: `Write proposedSolution(ciphertext_hex, key_hex, iv_hex) implementing AES-128-CBC decryption with PKCS#7 unpadding. Return decrypted plaintext as a lowercase hex string.

ciphertext_hex: hex string (multiple of 32 chars = multiple of 16-byte blocks). key_hex: 32 hex chars (16 bytes). iv_hex: 32 hex chars (16 bytes). Use ONLY Python built-ins.

Algorithm: 1) Hex-decode key, IV, ciphertext 2) AES-128 key expansion 3) For each 16-byte block: AES-ECB decrypt 4) XOR with previous ciphertext block (or IV for first block) 5) Remove PKCS#7 padding.

Example 1: proposedSolution("7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b273bed6b8e3c1743b7116e69e222295163ff1caa1681fac09120eca307586e1a7", "2b7e151628aed2a6abf7158809cf4f3c", "000102030405060708090a0b0c0d0e0f") → "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710"

Example 2: proposedSolution("6cd03227ae26f9b3cfa02e3dcb30b6e3", "2b7e151628aed2a6abf7158809cf4f3c", "000102030405060708090a0b0c0d0e0f") → "48656c6c6f576f726c64"`,
    language: "python",
    complexity: "very-hard",
  },
  // ── Data structures ─────────────────────────────────────────────────────────
  {
    name: "lru-cache",
    description: `Write proposedSolution(capacity, operations) implementing an LRU (Least Recently Used) cache with O(1) get and put using a doubly-linked list + hashmap. capacity is a positive integer (max cache size). operations is a list where each element is either: ["put", key, value] (insert/update — if full, evict the least-recently-used key before inserting) or ["get", key] (return value, or -1 if key not found). Accessing a key (get or put of existing key) marks it as most-recently-used. Return a list of results: for "put", return None; for "get", return the value (or -1).

Example 1: proposedSolution(2, [["put", 1, 10], ["put", 2, 20], ["get", 1], ["put", 3, 30], ["get", 2], ["get", 3]]) → [None, None, 10, None, -1, 30] (key 2 was evicted when key 3 was inserted)
Example 2: proposedSolution(1, [["put", 1, 100], ["get", 1], ["put", 2, 200], ["get", 1], ["get", 2]]) → [None, 100, None, -1, 200]
Example 3: proposedSolution(3, [["put", 1, 10], ["put", 2, 20], ["put", 1, 100], ["get", 1], ["get", 2]]) → [None, None, None, 100, 20] (update key 1, it's now most-recent)`,
    language: "python",
    complexity: "hard",
  },
  // ── String algorithms ──────────────────────────────────────────────────────
  {
    name: "kmp-string-search",
    description: `Write proposedSolution(text, pattern) implementing the Knuth-Morris-Pratt (KMP) string matching algorithm. Compute the failure function (LPS array — longest proper prefix that is also suffix) for the pattern, then use it to search text. Return the list of all starting indices (0-indexed) where pattern occurs in text. Return empty list if no matches. Must be O(n + m) where n = len(text), m = len(pattern). Handle overlapping matches.

Example 1: proposedSolution("ABABDABACDABABCABAB", "ABABCABAB") → [10] (pattern "ABABCABAB" found at index 10)
Example 2: proposedSolution("AAAAA", "AA") → [0, 1, 2, 3] (overlapping matches)
Example 3: proposedSolution("HELLO WORLD", "ABC") → []
Example 4: proposedSolution("ABCABCABC", "ABCABC") → [0, 3]`,
    language: "python",
    complexity: "hard",
  },
  // ── Graph algorithms ──────────────────────────────────────────────────────
  {
    name: "bellman-ford",
    description: `Write proposedSolution(graph, source) implementing the Bellman-Ford algorithm with negative cycle detection. graph is a list of (u, v, weight) edges where u and v are strings. source is a string node name. Return a dict with: "distances" (dict mapping node→shortest distance from source, float('inf') for unreachable), "predecessors" (dict mapping node→previous node in shortest path, None for source and unreachable), "has_negative_cycle" (bool — True if any node reachable from source can be part of a negative cycle). Run exactly V-1 relaxation passes where V is the number of unique nodes.

Example 1: proposedSolution([("A","B",4), ("A","C",2), ("B","C",-3), ("B","D",2), ("C","D",3)], "A") → {"distances": {"A":0,"B":4,"C":1,"D":4}, "predecessors": {"A":None,"B":"A","C":"B","D":"C"}, "has_negative_cycle": False}
Explanation: A→B=4, A→C=2 initial; then via B: A→B→C = 4-3 = 1 (beats 2); via C: A→B→C→D = 1+3 = 4 (beats A→B→D = 6)
Example 2: proposedSolution([("A","B",1), ("B","C",-2), ("C","A",-1)], "A") → has_negative_cycle: True (A→B→C→A = 1-2-1 = -2)
Example 3: proposedSolution([("A","B",5)], "A") → {"distances": {"A":0,"B":5}, "predecessors": {"A":None,"B":"A"}, "has_negative_cycle": False}
Example 4: proposedSolution([("X","Y",3)], "A") → distances: {"A":0, "X":inf, "Y":inf}, has_negative_cycle: False`,
    language: "python",
    complexity: "hard",
  },
  // ── Computational geometry ──────────────────────────────────────────────────
  {
    name: "convex-hull",
    description: `Write proposedSolution(points) implementing the Graham scan algorithm for computing the convex hull of a set of 2D points. points is a list of (x, y) tuples (floats or ints). Return the convex hull as a list of (x, y) tuples in counterclockwise order starting from the point with the lowest y-coordinate (break ties by lowest x). Include collinear points on the hull edges. If fewer than 3 points, return all points in CCW order.

Algorithm: 1) Find pivot (lowest y, then lowest x) 2) Sort other points by polar angle relative to pivot (use cross product for tiebreaking: closer point first) 3) Build hull using a stack: for each point, while last 3 points make a non-left turn (cross product <= 0 for strict hull), pop the middle one

Example 1: proposedSolution([(0,0), (1,0), (1,1), (0,1), (0.5,0.5)]) → [(0,0), (1,0), (1,1), (0,1)] (unit square, interior point excluded)
Example 2: proposedSolution([(0,0), (2,0), (1,1), (1,2), (0,2)]) → [(0,0), (2,0), (1,2), (0,2)] or equivalent CCW order
Example 3: proposedSolution([(0,0), (1,1), (2,2)]) → [(0,0), (2,2)] (collinear, endpoints only — interior collinear point excluded if on edge)`,
    language: "python",
    complexity: "hard",
  },
  // ── Number theory ──────────────────────────────────────────────────────────
  {
    name: "rsa-keygen",
    description: `Write proposedSolution(p, q, e) that computes RSA key components. p and q are prime numbers. e is the public exponent (coprime with φ(n)). Return a dict with: "n" (p*q), "phi" (φ = (p-1)*(q-1)), "e" (public exponent), "d" (private exponent = modular inverse of e mod φ), "public_key" (n, e), "private_key" (n, d). Also implement encrypt/decrypt: proposedSolution(mode, key, message) where mode is "encrypt" or "decrypt", key is (n, exp), message is an integer < n. Use pow(base, exp, mod) for modular exponentiation. Compute d using the Extended Euclidean algorithm.

Example 1: proposedSolution(61, 53, 17) → {"n": 3233, "phi": 3120, "e": 17, "d": 2753, "public_key": [3233, 17], "private_key": [3233, 2753]}
Example 2: proposedSolution("encrypt", [3233, 17], 65) → 2790
Example 3: proposedSolution("decrypt", [3233, 2753], 2790) → 65`,
    language: "python",
    complexity: "hard",
  },
  // ── Advanced data structures ─────────────────────────────────────────────────
  {
    name: "avl-tree",
    description: `Write proposedSolution(operations) implementing an AVL tree (self-balancing BST). operations is a list of ("insert", value) or ("search", value) tuples. All values are integers. After each insert, rebalance using rotations (LL, RR, LR, RL cases) to maintain balance factor in [-1, 0, 1]. For search, return True if the value exists, False otherwise. For insert, return the root value after insertion and rebalancing (or None for empty tree). Return a list of results (one per operation).

Example 1: proposedSolution([("insert", 10), ("insert", 20), ("insert", 30)]) → [10, 20, 20] (RR rotation at 10 after inserting 30, 20 becomes new root)
Example 2: proposedSolution([("insert", 30), ("insert", 20), ("insert", 10)]) → [30, 30, 20] (LL rotation at 30 after inserting 10, 20 becomes new root)
Example 3: proposedSolution([("insert", 10), ("insert", 20), ("search", 10), ("search", 30)]) → [10, 10, True, False]
Example 4: proposedSolution([("insert", 40), ("insert", 20), ("insert", 10), ("insert", 25), ("insert", 30)]) → [40, 40, 20, 20, 25] (LR rotation: 10→20→25→30, rebalance at 20)`,
    language: "python",
    complexity: "very-hard",
  },
  // ── Advanced graph algorithms ──────────────────────────────────────────────
  {
    name: "max-flow-edmonds-karp",
    description: `Write proposedSolution(graph, source, sink) implementing the Edmonds-Karp algorithm (BFS-based Ford-Fulkerson) for maximum flow. graph is a dict mapping node → list of (neighbor, capacity) tuples. All edges are directed. source and sink are string node names. Build a residual graph internally. At each step, find the shortest augmenting path (fewest edges) using BFS on edges with residual capacity > 0. Augment by the bottleneck capacity and update residual edges. Return the maximum flow value (integer).

Example 1: proposedSolution({"S":[("A",10),("B",5)], "A":[("T",10)], "B":[("A",15),("T",5)], "T":[]}, "S", "T") → 15 (S→B→A→T: 5 + S→A→T: 10)
Example 2: proposedSolution({"S":[("A",3),("B",2)], "A":[("B",1),("T",2)], "B":[("T",3)], "T":[]}, "S", "T") → 5
Example 3: proposedSolution({"S":[("A",5)], "A":[], "T":[]}, "S", "T") → 0 (no path from S to T)
Example 4: proposedSolution({"S":[("A",1),("B",1)], "A":[("C",1)], "B":[("C",1)], "C":[("T",1)], "T":[]}, "S", "T") → 1`,
    language: "python",
    complexity: "hard",
  },
  // ── Compiler/parsing ──────────────────────────────────────────────────────
  {
    name: "recursive-descent-parser",
    description: `Write proposedSolution(expression) that evaluates an arithmetic expression string using recursive descent parsing. expression contains integers, +, -, *, /, parentheses (), and spaces. Follow standard operator precedence: * and / before + and -, left-to-right within same precedence. Handle parentheses for grouping. Division is integer division (floor toward zero, like Python's // for positive results). Return the integer result.

Grammar:
  expr    → term (('+' | '-') term)*
  term    → factor (('*' | '/') factor)*
  factor  → NUMBER | '(' expr ')' | '-' factor

Example 1: proposedSolution("3 + 5") → 8
Example 2: proposedSolution("3 + 5 * 2") → 13 (not 16 — multiplication first)
Example 3: proposedSolution("(3 + 5) * 2") → 16
Example 4: proposedSolution("-3 + 5") → 2
Example 5: proposedSolution("3 + 4 * 2 / (1 - 5)") → 1 (4*2=8, 1-5=-4, 8//-4=-2, 3+(-2)=1)
Example 6: proposedSolution("10 / 3") → 3 (integer division)
Example 7: proposedSolution("2 * (3 + 4 * (5 - 2))") → 30 (5-2=3, 4*3=12, 3+12=15, 2*15=30)`,
    language: "python",
    complexity: "hard",
  },
  // ── Multi-file projects / CLI tools ───────────────────────────────────────
  {
    name: "word-count-cli",
    description: `Build a Python CLI tool in main.py that works like the Unix 'wc' command (simplified). It should:
- Accept a filename as a command-line argument: python3 main.py <file>
- Print "lines words chars filename" (space-separated, no labels)
- Count lines, words (whitespace-delimited), and characters exactly
- If no filename is given, print "Usage: python3 main.py <file>" and exit with code 1
- Handle files that don't exist: print "Error: file not found" and exit with code 1

Write a COMPLETE, working CLI tool. Test it with your own sample files before finishing.

After writing main.py, write a README.md explaining the design.`,
    language: "python",
    domain: "cli-project",
    complexity: "simple",
    projectTests: [
      {
        setupFiles: { "sample.txt": "hello world\nfoo bar baz\n" },
        command: "python3 main.py sample.txt",
        expectedOutput: "2 5 24 sample.txt",
        expectedExitCode: 0,
      },
      {
        setupFiles: { "empty.txt": "" },
        command: "python3 main.py empty.txt",
        expectedOutput: "0 0 0 empty.txt",
        expectedExitCode: 0,
      },
      {
        setupFiles: { "oneword.txt": "hello" },
        command: "python3 main.py oneword.txt",
        expectedOutput: "1 1 5 oneword.txt",
        expectedExitCode: 0,
      },
      {
        command: "python3 main.py",
        expectedOutput: "Usage:",
        expectedExitCode: 1,
      },
      {
        command: "python3 main.py nonexistent_file_12345.txt",
        expectedOutput: "not found",
        expectedExitCode: 1,
      },
    ],
  },
  {
    name: "csv-stats",
    description: `Build a Python CLI tool in main.py that computes summary statistics for a CSV file. It should:
- Accept a filename as argument: python3 main.py <file.csv>
- The CSV has headers in the first row
- Print for each NUMERIC column: "COLNAME: min=X, max=Y, mean=Z, median=W" (values rounded to 2 decimal places)
- Skip non-numeric columns (print "COLNAME: non-numeric, skipped")
- Handle empty CSV files: print "Error: empty file" and exit 1
- If file doesn't exist: print "Error: file not found" and exit 1
- If no filename given: print "Usage: python3 main.py <file.csv>" and exit 1

Use only Python built-in modules (csv module is fine). Write a README.md explaining the design.`,
    language: "python",
    domain: "cli-project",
    complexity: "medium",
    projectTests: [
      {
        setupFiles: {
          "test.csv": "name,age,score\nAlice,30,95.5\nBob,25,87.3\nCharlie,35,92.1\n",
        },
        command: "python3 main.py test.csv",
        expectedOutput: "non-numeric",
        expectedExitCode: 0,
      },
      {
        setupFiles: {
          "nums.csv": "a,b\n1,10\n2,20\n3,30\n",
        },
        command: "python3 main.py nums.csv",
        expectedOutput: "a: min=1",
        expectedExitCode: 0,
      },
      {
        setupFiles: { "empty.csv": "" },
        command: "python3 main.py empty.csv",
        expectedOutput: "empty",
        expectedExitCode: 1,
      },
      {
        command: "python3 main.py",
        expectedOutput: "Usage:",
        expectedExitCode: 1,
      },
      {
        command: "python3 main.py no_such_file.csv",
        expectedOutput: "not found",
        expectedExitCode: 1,
      },
    ],
  },
  // ── AI / Search ────────────────────────────────────────────────────────────
  {
    name: "a-star-pathfinding",
    description: `Write proposedSolution(grid, start, goal) implementing the A* search algorithm on a 2D grid. grid is a list of strings where each string is a row, '.' is passable, '#' is an obstacle. start and goal are (row, col) tuples. Use Manhattan distance as the heuristic. Diagonal moves are NOT allowed (4-directional only: up, down, left, right). Each move costs 1. Return the shortest path as a list of (row, col) tuples from start to goal (inclusive), or None if no path exists. If multiple shortest paths exist, any is acceptable.

Example 1: proposedSolution(["....", ".##.", "....", "...."], (0, 0), (3, 3)) → [(0,0), (0,1), (0,2), (0,3), (1,3), (2,3), (3,3)] or equivalent shortest path (length 7)
Example 2: proposedSolution(["....", "####", "....", "...."], (0, 0), (2, 0)) → None (wall completely blocks path)
Example 3: proposedSolution([".#.", "...", ".#."], (0, 0), (2, 2)) → [(0,0), (1,0), (1,1), (1,2), (2,2)]`,
    language: "python",
    complexity: "hard",
  },
  // ── Compression ────────────────────────────────────────────────────────────
  {
    name: "huffman-coding",
    description: `Write proposedSolution(text) implementing Huffman coding to build a frequency-based binary tree and generate prefix codes. text is a string of ASCII characters. Return a dict with: "tree" (the Huffman tree as nested lists: [left, right] for internal nodes, or a string character for leaf nodes), "codes" (dict mapping each character to its binary code string, e.g. {"a":"0", "b":"10", "c":"11"}), "encoded_length" (integer, total bits when encoding the text = sum of each char's frequency times its code length).

Algorithm: 1) Count character frequencies 2) Build a min-heap where each node is (frequency, id, tree) 3) Repeatedly extract the two smallest, combine into a new node [left, right] with combined frequency, push back 4) The single remaining node is the root. Assign '0' to left branch, '1' to right branch by DFS traversal.

Example 1: proposedSolution("aab") → tree: [["b", "a"]] (b and a are siblings, a has code "1", b has code "0"), codes: {"a":"1","b":"0"}, encoded_length: 3
Example 2: proposedSolution("aaaabbbcc") → codes: {"a":"0","b":"10","c":"11"}, encoded_length: 4*1 + 3*2 + 2*2 = 14
Example 3: proposedSolution("x") → tree: "x", codes: {"x":"0"}, encoded_length: 1
Example 4: proposedSolution("") → tree: None, codes: {}, encoded_length: 0`,
    language: "python",
    complexity: "hard",
  },
  // ── Monte Carlo / Numerical methods ─────────────────────────────────────────
  {
    name: "monte-carlo-pi",
    description: `Write proposedSolution(n) that estimates pi using Monte Carlo sampling. Generate n random (x, y) points uniformly in the square [-1, 1] x [-1, 1]. Count how many fall inside the unit circle (x² + y² <= 1). The ratio of points inside to total points approximates π/4. Return the estimate of pi as a float. Use Python's random module. Seed the random number generator with 42 at the start to make results reproducible.

Example 1: proposedSolution(10000) → ~3.14 (varies but should be close with seed 42)
Example 2: proposedSolution(100000) → ~3.141 (converges with more samples)
Example 3: proposedSolution(1) → 4.0 or 0.0 (a single point either lands inside or outside)
Example 4: proposedSolution(0) → 0.0`,
    language: "python",
    complexity: "medium",
  },
  // ── String encoding ───────────────────────────────────────────────────────
  {
    name: "run-length-encoding",
    description: `Write proposedSolution(text, mode) implementing run-length encoding (RLE) for lossless string compression. mode is "encode" (compress) or "decode" (decompress). For encode: replace each run of identical characters with the character followed by the count. Only encode runs of 2 or more. For decode: expand encoded strings back to the original.

Example 1: proposedSolution("AAABBBCCD", "encode") → "A3B3C2D1" or "A3B3C2D" (single char counts optional)
Example 2: proposedSolution("A3B3C2D1", "decode") → "AAABBBCCD"
Example 3: proposedSolution("HELLO WWWORLD", "encode") → "H1E1L2O1 1W3O1R1L1D1" or similar (handle spaces)
Example 4: proposedSolution("", "encode") → ""
Example 5: proposedSolution("", "decode") → ""
Example 6: proposedSolution("A10", "decode") → "AAAAAAAAAA" (handle multi-digit counts)
Example 7: proposedSolution("A", "encode") → "A1" or "A"`,
    language: "python",
    complexity: "simple",
  },
  // ── Trie data structure ────────────────────────────────────────────────────
  {
    name: "trie-autocomplete",
    description: `Write proposedSolution(operations) implementing a Trie (prefix tree) with insert, search, startsWith, and autocomplete operations. operations is a list of tuples: ("insert", word), ("search", word), ("startsWith", prefix), ("autocomplete", prefix). All words are lowercase a-z strings.

- "insert": insert word into the trie. Return None.
- "search": return True if word exists in the trie (was inserted exactly), False otherwise.
- "startsWith": return True if any word in the trie starts with the given prefix, False otherwise.
- "autocomplete": return a sorted list of all words in the trie that have the given prefix, up to a maximum of 5 results. Return empty list if no matches.

Return a list of results (one per operation).

Example 1: proposedSolution([("insert","apple"),("search","apple"),("search","app"),("startsWith","app"),("insert","app"),("search","app")]) → [None, True, False, True, None, True]
Example 2: proposedSolution([("insert","bat"),("insert","ball"),("insert","bark"),("autocomplete","ba")]) → [None, None, None, ["ball","bark"]] (max 5, sorted)
Example 3: proposedSolution([("insert","a"),("insert","aa"),("insert","aaa"),("autocomplete","a")]) → [None, None, None, ["a","aa","aaa"]]
Example 4: proposedSolution([("search",""),("startsWith",""),("autocomplete","never")]) → [False, False, []]`,
    language: "python",
    complexity: "hard",
  },
];
