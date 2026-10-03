/**
 * D4EXAM full-viewport scientific calculator.
 * Natural-entry math structures + UI matching D4EXAM design reference.
 * Preserves: CalculatorMode, ExamCalculatorFab, exam allow_calculator integration.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Calculator as CalcIcon, X, Delete } from "lucide-react";
import { cn } from "@/lib/utils";
import { App as CapApp } from "@capacitor/app";
import { isNativeShell } from "@/native/platform";

export type CalculatorMode = "basic" | "scientific";
type AngleMode = "DEG" | "RAD" | "GRAD";
type Props = { open: boolean; mode: CalculatorMode; onClose: () => void };

/* ═══════════════ AST ═══════════════ */

type Atom =
  | { t: "num"; v: string }
  | { t: "op"; v: string }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "pi" }
  | { t: "e" }
  | { t: "ans" }
  | { t: "x" }
  | { t: "i" }
  | { t: "pct" }
  | { t: "fact" }
  | { t: "fn"; name: string; arg: Atom[] }
  | { t: "frac"; num: Atom[]; den: Atom[] }
  | { t: "mixed"; whole: Atom[]; num: Atom[]; den: Atom[] }
  | { t: "sqrt"; arg: Atom[] }
  | { t: "cbrt"; arg: Atom[] }
  | { t: "nroot"; n: Atom[]; arg: Atom[] }
  | { t: "pow"; base: Atom[]; exp: Atom[] }
  | { t: "inv"; base: Atom[] }
  | { t: "sq"; base: Atom[] }
  | { t: "cube"; base: Atom[] }
  | { t: "logb"; base: Atom[]; arg: Atom[] }
  | { t: "nCr"; n: Atom[]; r: Atom[] }
  | { t: "nPr"; n: Atom[]; r: Atom[] }
  | { t: "mod"; a: Atom[]; b: Atom[] }
  | { t: "sum"; lo: Atom[]; hi: Atom[]; body: Atom[] }
  | { t: "integral"; lo: Atom[]; hi: Atom[]; body: Atom[] }
  | { t: "deriv"; body: Atom[]; at: Atom[] }
  | { t: "abs"; arg: Atom[] }
  | { t: "matrix"; rows: Atom[][][] };

type Slot = "main" | "num" | "den" | "whole" | "arg" | "exp" | "n" | "base" | "r" | "a" | "b" | "lo" | "hi" | "body" | "at" | "cell";
type Cursor = { path: number[]; slot: Slot };

function emptyCursor(): Cursor {
  return { path: [], slot: "main" };
}

/* ═══════════════ Math helpers ═══════════════ */

function toRad(x: number, angle: AngleMode): number {
  if (angle === "DEG") return (x * Math.PI) / 180;
  if (angle === "GRAD") return (x * Math.PI) / 200;
  return x;
}
function fromRad(x: number, angle: AngleMode): number {
  if (angle === "DEG") return (x * 180) / Math.PI;
  if (angle === "GRAD") return (x * 200) / Math.PI;
  return x;
}
function formatResult(v: number): string {
  if (!Number.isFinite(v)) return "Error";
  if (Object.is(v, -0)) return "0";
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e12 || abs < 1e-9))
    return v.toExponential(6).replace(/\.?0+e/, "e");
  return Number(v.toPrecision(12)).toString();
}
function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n) || n > 170) return NaN;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}
function nCr(n: number, r: number): number {
  if (r < 0 || n < 0 || !Number.isInteger(n) || !Number.isInteger(r) || r > n) return NaN;
  return factorial(n) / (factorial(r) * factorial(n - r));
}
function nPr(n: number, r: number): number {
  if (r < 0 || n < 0 || !Number.isInteger(n) || !Number.isInteger(r) || r > n) return NaN;
  return factorial(n) / factorial(n - r);
}

function evalAtoms(atoms: Atom[], angle: AngleMode, ans: number): number {
  const tokens: string[] = [];
  const emit = (a: Atom[]) => {
    for (const node of a) {
      switch (node.t) {
        case "num":
          tokens.push(node.v || "0");
          break;
        case "op":
          tokens.push(node.v);
          break;
        case "lparen":
          tokens.push("(");
          break;
        case "rparen":
          tokens.push(")");
          break;
        case "pi":
          tokens.push(String(Math.PI));
          break;
        case "e":
          tokens.push(String(Math.E));
          break;
        case "ans":
          tokens.push(String(ans));
          break;
        case "x":
        case "i":
          tokens.push("0");
          break;
        case "pct":
          tokens.push("%");
          break;
        case "fact":
          tokens.push("!");
          break;
        case "fn": {
          const arg = evalAtoms(node.arg.length ? node.arg : [{ t: "num", v: "0" }], angle, ans);
          let v = NaN;
          const name = node.name;
          if (name === "sin") v = Math.sin(toRad(arg, angle));
          else if (name === "cos") v = Math.cos(toRad(arg, angle));
          else if (name === "tan") v = Math.tan(toRad(arg, angle));
          else if (name === "asin") v = fromRad(Math.asin(arg), angle);
          else if (name === "acos") v = fromRad(Math.acos(arg), angle);
          else if (name === "atan") v = fromRad(Math.atan(arg), angle);
          else if (name === "sinh") v = Math.sinh(arg);
          else if (name === "cosh") v = Math.cosh(arg);
          else if (name === "tanh") v = Math.tanh(arg);
          else if (name === "ln") v = Math.log(arg);
          else if (name === "log" || name === "log10") v = Math.log10(arg);
          else if (name === "exp") v = Math.exp(arg);
          else if (name === "abs") v = Math.abs(arg);
          else if (name === "10^") v = Math.pow(10, arg);
          tokens.push(String(v));
          break;
        }
        case "frac": {
          const n = evalAtoms(node.num.length ? node.num : [{ t: "num", v: "0" }], angle, ans);
          const d = evalAtoms(node.den.length ? node.den : [{ t: "num", v: "1" }], angle, ans);
          tokens.push(String(n / d));
          break;
        }
        case "mixed": {
          const w = evalAtoms(node.whole.length ? node.whole : [{ t: "num", v: "0" }], angle, ans);
          const n = evalAtoms(node.num.length ? node.num : [{ t: "num", v: "0" }], angle, ans);
          const d = evalAtoms(node.den.length ? node.den : [{ t: "num", v: "1" }], angle, ans);
          tokens.push(String(w + n / d));
          break;
        }
        case "sqrt":
          tokens.push(
            String(Math.sqrt(evalAtoms(node.arg.length ? node.arg : [{ t: "num", v: "0" }], angle, ans))),
          );
          break;
        case "cbrt":
          tokens.push(
            String(Math.cbrt(evalAtoms(node.arg.length ? node.arg : [{ t: "num", v: "0" }], angle, ans))),
          );
          break;
        case "nroot": {
          const n = evalAtoms(node.n.length ? node.n : [{ t: "num", v: "2" }], angle, ans);
          const a = evalAtoms(node.arg.length ? node.arg : [{ t: "num", v: "0" }], angle, ans);
          tokens.push(String(Math.pow(a, 1 / n)));
          break;
        }
        case "pow": {
          const b = evalAtoms(node.base.length ? node.base : [{ t: "num", v: "0" }], angle, ans);
          const e = evalAtoms(node.exp.length ? node.exp : [{ t: "num", v: "1" }], angle, ans);
          tokens.push(String(Math.pow(b, e)));
          break;
        }
        case "inv": {
          const b = evalAtoms(node.base.length ? node.base : [{ t: "num", v: "1" }], angle, ans);
          tokens.push(String(1 / b));
          break;
        }
        case "sq": {
          const b = evalAtoms(node.base.length ? node.base : [{ t: "num", v: "0" }], angle, ans);
          tokens.push(String(b * b));
          break;
        }
        case "cube": {
          const b = evalAtoms(node.base.length ? node.base : [{ t: "num", v: "0" }], angle, ans);
          tokens.push(String(b * b * b));
          break;
        }
        case "logb": {
          const b = evalAtoms(node.base.length ? node.base : [{ t: "num", v: "10" }], angle, ans);
          const a = evalAtoms(node.arg.length ? node.arg : [{ t: "num", v: "1" }], angle, ans);
          tokens.push(String(Math.log(a) / Math.log(b)));
          break;
        }
        case "nCr": {
          const n = evalAtoms(node.n.length ? node.n : [{ t: "num", v: "0" }], angle, ans);
          const r = evalAtoms(node.r.length ? node.r : [{ t: "num", v: "0" }], angle, ans);
          tokens.push(String(nCr(n, r)));
          break;
        }
        case "nPr": {
          const n = evalAtoms(node.n.length ? node.n : [{ t: "num", v: "0" }], angle, ans);
          const r = evalAtoms(node.r.length ? node.r : [{ t: "num", v: "0" }], angle, ans);
          tokens.push(String(nPr(n, r)));
          break;
        }
        case "mod": {
          const a = evalAtoms(node.a.length ? node.a : [{ t: "num", v: "0" }], angle, ans);
          const b = evalAtoms(node.b.length ? node.b : [{ t: "num", v: "1" }], angle, ans);
          tokens.push(String(a % b));
          break;
        }
        case "sum": {
          const lo = Math.floor(evalAtoms(node.lo.length ? node.lo : [{ t: "num", v: "1" }], angle, ans));
          const hi = Math.floor(evalAtoms(node.hi.length ? node.hi : [{ t: "num", v: "1" }], angle, ans));
          let s = 0;
          const start = Math.min(lo, hi);
          const end = Math.max(lo, hi);
          if (end - start > 5000) {
            tokens.push("NaN");
            break;
          }
          for (let i = start; i <= end; i++) {
            // substitute X with i in body
            const body = substituteX(node.body.length ? node.body : [{ t: "num", v: "0" }], i);
            s += evalAtoms(body, angle, ans);
          }
          tokens.push(String(s));
          break;
        }
        case "integral": {
          const lo = evalAtoms(node.lo.length ? node.lo : [{ t: "num", v: "0" }], angle, ans);
          const hi = evalAtoms(node.hi.length ? node.hi : [{ t: "num", v: "1" }], angle, ans);
          const steps = 200;
          const h = (hi - lo) / steps;
          let s = 0;
          for (let k = 0; k <= steps; k++) {
            const x = lo + k * h;
            const body = substituteX(node.body.length ? node.body : [{ t: "num", v: "0" }], x);
            const y = evalAtoms(body, angle, ans);
            s += (k === 0 || k === steps ? 1 : 2) * y;
          }
          tokens.push(String((h / 2) * s));
          break;
        }
        case "abs": {
          const a = evalAtoms(node.arg.length ? node.arg : [{ t: "num", v: "0" }], angle, ans);
          tokens.push(String(Math.abs(a)));
          break;
        }
        case "deriv": {
          const at = evalAtoms(node.at.length ? node.at : [{ t: "num", v: "0" }], angle, ans);
          const eps = 1e-6;
          const body = node.body.length ? node.body : [{ t: "num", v: "0" }];
          const y1 = evalAtoms(substituteX(body, at + eps), angle, ans);
          const y0 = evalAtoms(substituteX(body, at - eps), angle, ans);
          tokens.push(String((y1 - y0) / (2 * eps)));
          break;
        }
      }
    }
  };
  emit(atoms);
  return evalTokenList(tokens);
}

/** Replace X / x atoms with a numeric value (for Σ, ∫, d/dx). */
function substituteX(atoms: Atom[], xVal: number): Atom[] {
  return atoms.map((node) => {
    if (node.t === "x") return { t: "num", v: String(xVal) };
    if (node.t === "fn") return { ...node, arg: substituteX(node.arg, xVal) };
    if (node.t === "frac") return { ...node, num: substituteX(node.num, xVal), den: substituteX(node.den, xVal) };
    if (node.t === "mixed")
      return {
        ...node,
        whole: substituteX(node.whole, xVal),
        num: substituteX(node.num, xVal),
        den: substituteX(node.den, xVal),
      };
    if (node.t === "abs") return { ...node, arg: substituteX(node.arg, xVal) };
    if (node.t === "sqrt" || node.t === "cbrt") return { ...node, arg: substituteX(node.arg, xVal) };
    if (node.t === "nroot") return { ...node, n: substituteX(node.n, xVal), arg: substituteX(node.arg, xVal) };
    if (node.t === "pow") return { ...node, base: substituteX(node.base, xVal), exp: substituteX(node.exp, xVal) };
    if (node.t === "inv" || node.t === "sq" || node.t === "cube")
      return { ...node, base: substituteX(node.base, xVal) };
    if (node.t === "logb") return { ...node, base: substituteX(node.base, xVal), arg: substituteX(node.arg, xVal) };
    if (node.t === "sum")
      return {
        ...node,
        lo: substituteX(node.lo, xVal),
        hi: substituteX(node.hi, xVal),
        body: substituteX(node.body, xVal),
      };
    if (node.t === "integral")
      return {
        ...node,
        lo: substituteX(node.lo, xVal),
        hi: substituteX(node.hi, xVal),
        body: substituteX(node.body, xVal),
      };
    if (node.t === "deriv")
      return { ...node, body: substituteX(node.body, xVal), at: substituteX(node.at, xVal) };
    return node;
  });
}

function isValueToken(t: string): boolean {
  if (t === "(" || t === ")") return false;
  if (["+", "−", "-", "×", "÷", "^", "%", "!"].includes(t)) return false;
  return t.length > 0;
}

function evalTokenList(tokens: string[]): number {
  // Expand % / ! then insert implicit multiplication: 2(3)→2×(3), 2π→2×π, )( → )×(
  const step1: string[] = [];
  for (const t of tokens) {
    if (t === "%") {
      step1.push("/", "100");
      continue;
    }
    if (t === "!") {
      const prev = step1.pop();
      step1.push(String(factorial(Number(prev))));
      continue;
    }
    step1.push(t);
  }
  const expanded: string[] = [];
  for (let i = 0; i < step1.length; i++) {
    const t = step1[i]!;
    const prev = expanded.length ? expanded[expanded.length - 1]! : null;
    if (prev != null) {
      const needMul =
        // number/const before (
        (isValueToken(prev) && t === "(") ||
        // ) before number/const or (
        (prev === ")" && (t === "(" || isValueToken(t))) ||
        // number before number (e.g. from constants sequenced) — only if both pure numbers
        (isValueToken(prev) && isValueToken(t) && !["+", "−", "-", "×", "÷", "^"].includes(prev));
      if (needMul) expanded.push("×");
    }
    expanded.push(t);
  }
  const prec: Record<string, number> = { "+": 1, "−": 1, "-": 1, "×": 2, "÷": 2, "^": 3 };
  const right: Record<string, boolean> = { "^": true };
  const out: string[] = [];
  const ops: string[] = [];
  for (const t of expanded) {
    if (t === "(") ops.push(t);
    else if (t === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") out.push(ops.pop()!);
      ops.pop();
    } else if (prec[t] != null) {
      while (
        ops.length &&
        ops[ops.length - 1] !== "(" &&
        prec[ops[ops.length - 1]!] != null &&
        (right[t]
          ? prec[ops[ops.length - 1]!]! > prec[t]!
          : prec[ops[ops.length - 1]!]! >= prec[t]!)
      )
        out.push(ops.pop()!);
      ops.push(t);
    } else out.push(t);
  }
  while (ops.length) out.push(ops.pop()!);
  const st: number[] = [];
  for (const t of out) {
    if (prec[t] != null) {
      const b = st.pop() ?? 0;
      const a = st.pop() ?? 0;
      if (t === "+") st.push(a + b);
      else if (t === "−" || t === "-") st.push(a - b);
      else if (t === "×") st.push(a * b);
      else if (t === "÷") st.push(a / b);
      else if (t === "^") st.push(Math.pow(a, b));
    } else st.push(Number(t));
  }
  return st.length ? st[st.length - 1]! : NaN;
}

/* ═══════════════ Cursor / list helpers ═══════════════ */

function getListAt(atoms: Atom[], cur: Cursor): Atom[] {
  if (cur.path.length === 0) return atoms;
  const node = atoms[cur.path[0]!];
  if (!node) return atoms;
  if (node.t === "frac") return cur.slot === "den" ? node.den : node.num;
  if (node.t === "mixed") {
    if (cur.slot === "whole") return node.whole;
    if (cur.slot === "den") return node.den;
    return node.num;
  }
  if (node.t === "sqrt" || node.t === "cbrt" || node.t === "fn") return node.arg;
  if (node.t === "nroot") return cur.slot === "n" ? node.n : node.arg;
  if (node.t === "pow") return cur.slot === "exp" ? node.exp : node.base;
  if (node.t === "inv" || node.t === "sq" || node.t === "cube") return node.base;
  if (node.t === "logb") return cur.slot === "base" ? node.base : node.arg;
  if (node.t === "nCr" || node.t === "nPr") return cur.slot === "r" ? node.r : node.n;
  if (node.t === "mod") return cur.slot === "b" ? node.b : node.a;
  if (node.t === "sum" || node.t === "integral") {
    if (cur.slot === "lo") return node.lo;
    if (cur.slot === "hi") return node.hi;
    return node.body;
  }
  if (node.t === "deriv") {
    if (cur.slot === "at") return node.at;
    return node.body;
  }
  return atoms;
}

function setListAt(atoms: Atom[], cur: Cursor, nextList: Atom[]): Atom[] {
  if (cur.path.length === 0) return nextList;
  const clone = structuredClone(atoms) as Atom[];
  const node = clone[cur.path[0]!];
  if (!node) return atoms;
  if (node.t === "frac") {
    if (cur.slot === "den") node.den = nextList;
    else node.num = nextList;
  } else if (node.t === "mixed") {
    if (cur.slot === "whole") node.whole = nextList;
    else if (cur.slot === "den") node.den = nextList;
    else node.num = nextList;
  } else if (node.t === "sqrt" || node.t === "cbrt" || node.t === "fn") node.arg = nextList;
  else if (node.t === "nroot") {
    if (cur.slot === "n") node.n = nextList;
    else node.arg = nextList;
  } else if (node.t === "pow") {
    if (cur.slot === "exp") node.exp = nextList;
    else node.base = nextList;
  } else if (node.t === "inv" || node.t === "sq" || node.t === "cube") node.base = nextList;
  else if (node.t === "logb") {
    if (cur.slot === "base") node.base = nextList;
    else node.arg = nextList;
  } else if (node.t === "nCr" || node.t === "nPr") {
    if (cur.slot === "r") node.r = nextList;
    else node.n = nextList;
  } else if (node.t === "mod") {
    if (cur.slot === "b") node.b = nextList;
    else node.a = nextList;
  } else if (node.t === "sum" || node.t === "integral") {
    if (cur.slot === "lo") node.lo = nextList;
    else if (cur.slot === "hi") node.hi = nextList;
    else node.body = nextList;
  } else if (node.t === "deriv") {
    if (cur.slot === "at") node.at = nextList;
    else node.body = nextList;
  }
  return clone;
}

function popTrailingNum(list: Atom[]): Atom[] {
  if (list.length && list[list.length - 1]!.t === "num") return [list.pop()!];
  if (list.length && list[list.length - 1]!.t === "rparen") {
    // take last paren group roughly as single atom
    return [list.pop()!];
  }
  return [];
}

function insertAt(atoms: Atom[], cur: Cursor, item: Atom): { atoms: Atom[]; cur: Cursor } {
  const list = [...getListAt(atoms, cur)];

  // Fraction: if trailing number exists at main level, use as numerator
  if (item.t === "frac" && cur.path.length === 0) {
    const num = popTrailingNum(list);
    list.push({ t: "frac", num: num.length ? num : [], den: [] });
    return {
      atoms: setListAt(atoms, cur, list),
      cur: { path: [list.length - 1], slot: num.length ? "den" : "num" },
    };
  }
  if (item.t === "frac") {
    list.push(item);
    return {
      atoms: setListAt(atoms, cur, list),
      cur: { path: cur.path.length ? cur.path : [list.length - 1], slot: "num" },
    };
  }
  if (item.t === "mixed") {
    const whole = popTrailingNum(list);
    list.push({ t: "mixed", whole, num: [], den: [] });
    return {
      atoms: setListAt(atoms, cur, list),
      cur: { path: [list.length - 1], slot: "num" },
    };
  }
  if (item.t === "abs") {
    list.push(item);
    return { atoms: setListAt(atoms, cur, list), cur: { path: [list.length - 1], slot: "arg" } };
  }
  if (item.t === "sqrt" || item.t === "cbrt") {
    list.push(item);
    return { atoms: setListAt(atoms, cur, list), cur: { path: [list.length - 1], slot: "arg" } };
  }
  if (item.t === "nroot") {
    list.push(item);
    return { atoms: setListAt(atoms, cur, list), cur: { path: [list.length - 1], slot: "n" } };
  }
  if (item.t === "pow" || item.t === "sq" || item.t === "cube" || item.t === "inv") {
    const base = popTrailingNum(list);
    if (item.t === "pow") {
      list.push({ t: "pow", base: base.length ? base : [], exp: [] });
      return { atoms: setListAt(atoms, cur, list), cur: { path: [list.length - 1], slot: "exp" } };
    }
    if (item.t === "sq") {
      list.push({ t: "sq", base: base.length ? base : [] });
      return { atoms: setListAt(atoms, cur, list), cur };
    }
    if (item.t === "cube") {
      list.push({ t: "cube", base: base.length ? base : [] });
      return { atoms: setListAt(atoms, cur, list), cur };
    }
    list.push({ t: "inv", base: base.length ? base : [] });
    return { atoms: setListAt(atoms, cur, list), cur };
  }
  if (item.t === "fn" || item.t === "logb") {
    list.push(item);
    return { atoms: setListAt(atoms, cur, list), cur: { path: [list.length - 1], slot: "arg" } };
  }
  if (item.t === "nCr" || item.t === "nPr") {
    const n = popTrailingNum(list);
    if (item.t === "nCr") list.push({ t: "nCr", n: n.length ? n : [], r: [] });
    else list.push({ t: "nPr", n: n.length ? n : [], r: [] });
    return { atoms: setListAt(atoms, cur, list), cur: { path: [list.length - 1], slot: "r" } };
  }
  if (item.t === "mod") {
    const a = popTrailingNum(list);
    list.push({ t: "mod", a: a.length ? a : [], b: [] });
    return { atoms: setListAt(atoms, cur, list), cur: { path: [list.length - 1], slot: "b" } };
  }
  if (item.t === "sum" || item.t === "integral") {
    list.push(item);
    return { atoms: setListAt(atoms, cur, list), cur: { path: [list.length - 1], slot: "lo" } };
  }
  if (item.t === "deriv") {
    list.push(item);
    return { atoms: setListAt(atoms, cur, list), cur: { path: [list.length - 1], slot: "body" } };
  }
  if (item.t === "num" && list.length && list[list.length - 1]!.t === "num") {
    const last = list[list.length - 1] as { t: "num"; v: string };
    if (item.v === "." && last.v.includes(".")) return { atoms, cur };
    last.v = last.v + item.v;
    return { atoms: setListAt(atoms, cur, list), cur };
  }
  list.push(item);
  return { atoms: setListAt(atoms, cur, list), cur };
}

function backspace(atoms: Atom[], cur: Cursor): { atoms: Atom[]; cur: Cursor } {
  const list = [...getListAt(atoms, cur)];
  if (!list.length) {
    if (cur.path.length) return { atoms, cur: emptyCursor() };
    return { atoms, cur };
  }
  const last = list[list.length - 1]!;
  if (last.t === "num" && last.v.length > 1) {
    last.v = last.v.slice(0, -1);
    return { atoms: setListAt(atoms, cur, list), cur };
  }
  list.pop();
  return { atoms: setListAt(atoms, cur, list), cur };
}

/* ═══════════════ Visual ═══════════════ */

function Caret({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <span
      className="mx-px inline-block h-[1.15em] w-[2.5px] animate-pulse rounded-sm bg-[#38bdf8] align-middle"
      aria-hidden
    />
  );
}

function SlotBox({
  atoms,
  active,
  onFocus,
  minW = "1.35em",
}: {
  atoms: Atom[];
  active: boolean;
  onFocus: () => void;
  minW?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onFocus();
      }}
      className={cn(
        "inline-flex min-h-[1.25em] items-center justify-center rounded-md border align-middle leading-none transition-colors",
        active
          ? "border-[#38bdf8] bg-[#1d4ed8]/45 shadow-[0_0_0_1px_rgba(56,189,248,0.45),inset_0_1px_0_rgba(255,255,255,0.12)]"
          : "border-[#3b82f6]/55 bg-[#1e3a8a]/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
      )}
      style={{ minWidth: minW, minHeight: "1.35em", padding: "0.12em 0.35em" }}
    >
      {atoms.length === 0 ? (
        <Caret on={active} />
      ) : (
        <>
          <AtomRow atoms={atoms} cursor={null} onCursor={() => onFocus()} />
          <Caret on={active} />
        </>
      )}
    </button>
  );
}

function AtomRow({
  atoms,
  cursor,
  onCursor,
  pathPrefix = [],
}: {
  atoms: Atom[];
  cursor: Cursor | null;
  onCursor: (c: Cursor) => void;
  pathPrefix?: number[];
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-px font-serif text-[1.08em] leading-tight text-white">
      {atoms.map((node, i) => (
        <AtomView
          key={i}
          node={node}
          index={i}
          cursor={cursor}
          pathPrefix={pathPrefix}
          onCursor={onCursor}
        />
      ))}
      {cursor && cursor.path.length === pathPrefix.length && cursor.slot === "main" ? (
        <Caret on />
      ) : null}
    </span>
  );
}

function AtomView({
  node,
  index,
  cursor,
  pathPrefix,
  onCursor,
}: {
  node: Atom;
  index: number;
  cursor: Cursor | null;
  pathPrefix: number[];
  onCursor: (c: Cursor) => void;
}) {
  const path = [...pathPrefix, index];
  const active = (slot: Slot) =>
    Boolean(
      cursor &&
        cursor.path.length === path.length &&
        path.every((p, j) => cursor!.path[j] === p) &&
        cursor.slot === slot,
    );

  switch (node.t) {
    case "num":
      return <span className="tabular-nums tracking-tight">{node.v}</span>;
    case "op":
      return <span className="mx-0.5 opacity-95">{node.v}</span>;
    case "lparen":
      return <span>(</span>;
    case "rparen":
      return <span>)</span>;
    case "pi":
      return <span className="italic">π</span>;
    case "e":
      return <span className="italic">e</span>;
    case "ans":
      return <span className="font-sans text-[0.82em] font-bold text-sky-300">Ans</span>;
    case "x":
      return <span className="italic">x</span>;
    case "i":
      return <span className="italic">i</span>;
    case "pct":
      return <span>%</span>;
    case "abs":
      return (
        <span className="mx-0.5 inline-flex items-center font-sans">
          <span className="opacity-80">|</span>
          <SlotBox atoms={node.arg} active={active("arg")} onFocus={() => onCursor({ path, slot: "arg" })} />
          <span className="opacity-80">|</span>
        </span>
      );
    case "fact":
      return <span>!</span>;
    case "frac":
      return (
        <span className="mx-0.5 inline-flex flex-col items-center align-middle text-[0.9em] leading-none">
          <SlotBox atoms={node.num} active={active("num")} onFocus={() => onCursor({ path, slot: "num" })} />
          <span className="my-px h-[1.5px] w-full min-w-[1.35em] bg-white" />
          <SlotBox atoms={node.den} active={active("den")} onFocus={() => onCursor({ path, slot: "den" })} />
        </span>
      );
    case "mixed":
      return (
        <span className="mx-0.5 inline-flex items-center gap-0.5 align-middle">
          <SlotBox
            atoms={node.whole}
            active={active("whole")}
            onFocus={() => onCursor({ path, slot: "whole" })}
            minW="0.65em"
          />
          <span className="inline-flex flex-col items-center text-[0.86em] leading-none">
            <SlotBox atoms={node.num} active={active("num")} onFocus={() => onCursor({ path, slot: "num" })} />
            <span className="my-px h-[1.5px] w-full min-w-[1.15em] bg-white" />
            <SlotBox atoms={node.den} active={active("den")} onFocus={() => onCursor({ path, slot: "den" })} />
          </span>
        </span>
      );
    case "sqrt":
      return (
        <span className="mx-0.5 inline-flex items-stretch align-middle">
          <span className="self-end pb-0.5 pr-px text-[1.2em] leading-none">√</span>
          <span className="inline-flex border-t-2 border-white pt-0.5">
            <SlotBox
              atoms={node.arg}
              active={active("arg")}
              onFocus={() => onCursor({ path, slot: "arg" })}
              minW="1.15em"
            />
          </span>
        </span>
      );
    case "cbrt":
      return (
        <span className="mx-0.5 inline-flex items-stretch align-middle">
          <span className="relative self-end pb-0.5 pr-px text-[1.2em] leading-none">
            <sup className="absolute -left-1.5 top-0 text-[0.52em] font-sans">3</sup>√
          </span>
          <span className="inline-flex border-t-2 border-white pt-0.5">
            <SlotBox
              atoms={node.arg}
              active={active("arg")}
              onFocus={() => onCursor({ path, slot: "arg" })}
              minW="1.15em"
            />
          </span>
        </span>
      );
    case "nroot":
      return (
        <span className="mx-0.5 inline-flex items-stretch align-middle">
          <span className="relative self-end pb-0.5 pr-px text-[1.2em] leading-none">
            <span className="absolute -left-2.5 top-0 scale-90">
              <SlotBox
                atoms={node.n}
                active={active("n")}
                onFocus={() => onCursor({ path, slot: "n" })}
                minW="0.55em"
              />
            </span>
            √
          </span>
          <span className="inline-flex border-t-2 border-white pt-0.5">
            <SlotBox
              atoms={node.arg}
              active={active("arg")}
              onFocus={() => onCursor({ path, slot: "arg" })}
              minW="1.15em"
            />
          </span>
        </span>
      );
    case "pow":
      return (
        <span className="mx-0.5 inline-flex items-start align-middle">
          <SlotBox
            atoms={node.base}
            active={active("base")}
            onFocus={() => onCursor({ path, slot: "base" })}
            minW="0.65em"
          />
          <sup className="ml-px text-[0.7em]">
            <SlotBox
              atoms={node.exp}
              active={active("exp")}
              onFocus={() => onCursor({ path, slot: "exp" })}
              minW="0.55em"
            />
          </sup>
        </span>
      );
    case "sq":
      return (
        <span className="mx-0.5 inline-flex items-start">
          <SlotBox
            atoms={node.base}
            active={active("base")}
            onFocus={() => onCursor({ path, slot: "base" })}
            minW="0.65em"
          />
          <sup className="text-[0.7em]">2</sup>
        </span>
      );
    case "cube":
      return (
        <span className="mx-0.5 inline-flex items-start">
          <SlotBox
            atoms={node.base}
            active={active("base")}
            onFocus={() => onCursor({ path, slot: "base" })}
            minW="0.65em"
          />
          <sup className="text-[0.7em]">3</sup>
        </span>
      );
    case "inv":
      return (
        <span className="mx-0.5 inline-flex items-start">
          <SlotBox
            atoms={node.base}
            active={active("base")}
            onFocus={() => onCursor({ path, slot: "base" })}
            minW="0.65em"
          />
          <sup className="text-[0.7em]">−1</sup>
        </span>
      );
    case "fn": {
      const label =
        node.name === "asin"
          ? "sin⁻¹"
          : node.name === "acos"
            ? "cos⁻¹"
            : node.name === "atan"
              ? "tan⁻¹"
              : node.name === "10^"
                ? "10"
                : node.name;
      return (
        <span className="mx-0.5 inline-flex items-center font-sans text-[0.88em]">
          <span className="mr-0.5">{label}</span>
          {node.name === "10^" ? <sup className="mr-0.5">□</sup> : null}(
          <SlotBox atoms={node.arg} active={active("arg")} onFocus={() => onCursor({ path, slot: "arg" })} />)
        </span>
      );
    }
    case "logb":
      return (
        <span className="mx-0.5 inline-flex items-end font-sans text-[0.88em]">
          <span>
            log
            <sub className="ml-px">
              <SlotBox
                atoms={node.base}
                active={active("base")}
                onFocus={() => onCursor({ path, slot: "base" })}
                minW="0.5em"
              />
            </sub>
          </span>
          (
          <SlotBox atoms={node.arg} active={active("arg")} onFocus={() => onCursor({ path, slot: "arg" })} />)
        </span>
      );
    case "nCr":
      return (
        <span className="mx-0.5 inline-flex items-center font-sans text-[0.88em]">
          <SlotBox atoms={node.n} active={active("n")} onFocus={() => onCursor({ path, slot: "n" })} minW="0.55em" />
          <span className="mx-0.5">C</span>
          <SlotBox atoms={node.r} active={active("r")} onFocus={() => onCursor({ path, slot: "r" })} minW="0.55em" />
        </span>
      );
    case "nPr":
      return (
        <span className="mx-0.5 inline-flex items-center font-sans text-[0.88em]">
          <SlotBox atoms={node.n} active={active("n")} onFocus={() => onCursor({ path, slot: "n" })} minW="0.55em" />
          <span className="mx-0.5">P</span>
          <SlotBox atoms={node.r} active={active("r")} onFocus={() => onCursor({ path, slot: "r" })} minW="0.55em" />
        </span>
      );
    case "mod":
      return (
        <span className="mx-0.5 inline-flex items-center font-sans text-[0.88em]">
          <SlotBox atoms={node.a} active={active("a")} onFocus={() => onCursor({ path, slot: "a" })} />
          <span className="mx-1 text-[0.8em] opacity-80">mod</span>
          <SlotBox atoms={node.b} active={active("b")} onFocus={() => onCursor({ path, slot: "b" })} />
        </span>
      );
    case "sum":
      return (
        <span className="mx-0.5 inline-flex items-end font-sans text-[0.88em]">
          <span className="mr-0.5 text-[1.2em] leading-none">Σ</span>
          <span className="inline-flex flex-col items-center text-[0.65em] leading-none">
            <SlotBox atoms={node.hi} active={active("hi")} onFocus={() => onCursor({ path, slot: "hi" })} minW="0.5em" />
            <span className="my-px opacity-50">—</span>
            <SlotBox atoms={node.lo} active={active("lo")} onFocus={() => onCursor({ path, slot: "lo" })} minW="0.5em" />
          </span>
          <span className="ml-0.5">(</span>
          <SlotBox atoms={node.body} active={active("body")} onFocus={() => onCursor({ path, slot: "body" })} />
          <span>)</span>
        </span>
      );
    case "integral":
      return (
        <span className="mx-0.5 inline-flex items-end font-sans text-[0.88em]">
          <span className="mr-0.5 text-[1.25em] leading-none">∫</span>
          <span className="inline-flex flex-col items-center text-[0.65em] leading-none">
            <SlotBox atoms={node.hi} active={active("hi")} onFocus={() => onCursor({ path, slot: "hi" })} minW="0.5em" />
            <SlotBox atoms={node.lo} active={active("lo")} onFocus={() => onCursor({ path, slot: "lo" })} minW="0.5em" />
          </span>
          <SlotBox atoms={node.body} active={active("body")} onFocus={() => onCursor({ path, slot: "body" })} />
          <span className="ml-0.5 italic">dx</span>
        </span>
      );
    case "deriv":
      return (
        <span className="mx-0.5 inline-flex items-center font-sans text-[0.85em]">
          <span className="mr-0.5">d/dx</span>
          <span>[</span>
          <SlotBox atoms={node.body} active={active("body")} onFocus={() => onCursor({ path, slot: "body" })} />
          <span>](</span>
          <SlotBox atoms={node.at} active={active("at")} onFocus={() => onCursor({ path, slot: "at" })} minW="0.55em" />
          <span>)</span>
        </span>
      );
    default:
      return null;
  }
}

/* ═══════════════ Keypad layout (matches reference) ═══════════════ */

type Tone = "shift" | "ac" | "fn" | "num" | "op" | "eq" | "nav" | "bk";
type KeyDef = {
  label: ReactNode;
  sub?: ReactNode;
  action: string;
  shiftAction?: string;
  tone: Tone;
  span?: number;
};

function scientificRows(): KeyDef[][] {
  return [
    [
      { label: "SHIFT", action: "SHIFT", tone: "shift" },
      { label: "MENU", action: "MENU", tone: "fn" },
      { label: "◀", action: "LEFT", tone: "nav" },
      { label: "▶", action: "RIGHT", tone: "nav" },
      { label: "⌫", action: "BKSP", tone: "bk" },
      { label: "AC", action: "AC", tone: "ac" },
    ],
    [
      { label: "DRG", action: "DRG", tone: "fn" },
      { label: "a/b", action: "frac", tone: "fn" },
      { label: "aᵇ/c", action: "mixed", tone: "fn" },
      { label: "Σ", action: "sum", tone: "fn" },
      { label: "∫", action: "integral", tone: "fn" },
      { label: "d/dx", action: "deriv", tone: "fn" },
    ],
    [
      { label: "CONV", action: "CONV", tone: "fn" },
      { label: "π", action: "pi", tone: "fn" },
      { label: "e", action: "e", tone: "fn" },
      { label: "Ans", action: "ans", tone: "fn" },
      { label: "MR", action: "MR", tone: "fn" },
      { label: "M+", action: "M+", tone: "fn" },
      { label: "M−", action: "M-", tone: "fn" },
    ],
    [
      { label: "sin", sub: "sin⁻¹", action: "sin", shiftAction: "asin", tone: "fn" },
      { label: "cos", sub: "cos⁻¹", action: "cos", shiftAction: "acos", tone: "fn" },
      { label: "tan", sub: "tan⁻¹", action: "tan", shiftAction: "atan", tone: "fn" },
      { label: "ln", action: "ln", tone: "fn" },
      { label: "log", action: "log", tone: "fn" },
      { label: "Abs", action: "abs", tone: "fn" },
      { label: "i", action: "i", tone: "fn" },
    ],
    [
      { label: "x⁻¹", action: "inv", tone: "fn" },
      { label: "x²", sub: "xʸ", action: "sq", shiftAction: "pow", tone: "fn" },
      { label: "x³", action: "cube", tone: "fn" },
      { label: "√", action: "sqrt", tone: "fn" },
      { label: "∛", action: "cbrt", tone: "fn" },
      { label: "ⁿ√", action: "nroot", tone: "fn" },
      { label: "10ˣ", sub: "eˣ", action: "tenx", shiftAction: "exp", tone: "fn" },
    ],
    [
      { label: "eˣ", action: "exp", tone: "fn" },
      { label: "n!", action: "fact", tone: "fn" },
      { label: "nCr", action: "nCr", tone: "fn" },
      { label: "nPr", action: "nPr", tone: "fn" },
      { label: "%", action: "%", tone: "fn" },
      { label: "mod", action: "mod", tone: "fn" },
      { label: "X", sub: "Y", action: "x", shiftAction: "y", tone: "fn" },
    ],
    [
      { label: "7", action: "7", tone: "num" },
      { label: "8", action: "8", tone: "num" },
      { label: "9", action: "9", tone: "num" },
      { label: "(", action: "(", tone: "op" },
      { label: ")", action: ")", tone: "op" },
      { label: "÷", action: "÷", tone: "op" },
    ],
    [
      { label: "4", action: "4", tone: "num" },
      { label: "5", action: "5", tone: "num" },
      { label: "6", action: "6", tone: "num" },
      { label: "×", action: "×", tone: "op" },
      { label: "−", action: "−", tone: "op" },
      { label: "+", action: "+", tone: "op" },
    ],
    [
      { label: "1", action: "1", tone: "num" },
      { label: "2", action: "2", tone: "num" },
      { label: "3", action: "3", tone: "num" },
      { label: "0", action: "0", tone: "op" },
      { label: ".", action: ".", tone: "op" },
      { label: "±", action: "neg", tone: "op" },
    ],
    [
      { label: "EXP", action: "EXP", tone: "fn" },
      { label: "RND", action: "rand", tone: "fn" },
      { label: "MATRIX", action: "MATRIX", tone: "fn", span: 2 },
      { label: "=", action: "=", tone: "eq", span: 2 },
    ],
  ];
}

function basicRows(): KeyDef[][] {
  return [
    [
      { label: "AC", action: "AC", tone: "ac" },
      { label: "⌫", action: "BKSP", tone: "bk" },
      { label: "ᵃ/ᵇ", action: "frac", tone: "fn" },
      { label: "÷", action: "÷", tone: "op" },
    ],
    [
      { label: "7", action: "7", tone: "num" },
      { label: "8", action: "8", tone: "num" },
      { label: "9", action: "9", tone: "num" },
      { label: "×", action: "×", tone: "op" },
    ],
    [
      { label: "4", action: "4", tone: "num" },
      { label: "5", action: "5", tone: "num" },
      { label: "6", action: "6", tone: "num" },
      { label: "−", action: "−", tone: "op" },
    ],
    [
      { label: "1", action: "1", tone: "num" },
      { label: "2", action: "2", tone: "num" },
      { label: "3", action: "3", tone: "num" },
      { label: "+", action: "+", tone: "op" },
    ],
    [
      { label: "0", action: "0", tone: "num" },
      { label: ".", action: ".", tone: "num" },
      { label: "√", action: "sqrt", tone: "fn" },
      { label: "=", action: "=", tone: "eq" },
    ],
  ];
}

const TONE: Record<Tone, string> = {
  shift:
    "bg-gradient-to-b from-[#34d399] to-[#059669] text-white shadow-[0_3px_0_0_#064e3b,0_0_12px_rgba(16,185,129,0.25)] active:translate-y-[2px] active:shadow-[0_1px_0_0_#064e3b]",
  ac: "bg-gradient-to-b from-[#fb923c] to-[#ea580c] text-white shadow-[0_3px_0_0_#9a3412,0_0_12px_rgba(249,115,22,0.25)] active:translate-y-[2px] active:shadow-[0_1px_0_0_#9a3412]",
  bk: "bg-gradient-to-b from-[#3b82c4] to-[#1e4a7a] text-white shadow-[0_3px_0_0_#0f2744] active:translate-y-[2px] active:shadow-[0_1px_0_0_#0f2744]",
  fn: "bg-gradient-to-b from-[#2b5a9e] to-[#163a6b] text-white shadow-[0_3px_0_0_#0a1e3d,inset_0_1px_0_rgba(255,255,255,0.12)] active:translate-y-[2px] active:shadow-[0_1px_0_0_#0a1e3d]",
  nav: "bg-gradient-to-b from-[#2b5a9e] to-[#163a6b] text-white shadow-[0_3px_0_0_#0a1e3d] active:translate-y-[2px] active:shadow-[0_1px_0_0_#0a1e3d]",
  num: "bg-gradient-to-b from-[#1e293b] to-[#0f172a] text-white shadow-[0_3px_0_0_#020617,inset_0_1px_0_rgba(255,255,255,0.06)] active:translate-y-[2px] active:shadow-[0_1px_0_0_#020617]",
  op: "bg-gradient-to-b from-[#3b82f6] to-[#1d4ed8] text-white shadow-[0_3px_0_0_#1e3a8a,inset_0_1px_0_rgba(255,255,255,0.15)] active:translate-y-[2px] active:shadow-[0_1px_0_0_#1e3a8a]",
  eq: "bg-gradient-to-b from-[#60a5fa] to-[#2563eb] text-white font-extrabold shadow-[0_3px_0_0_#1e40af,0_0_16px_rgba(37,99,235,0.35)] active:translate-y-[2px] active:shadow-[0_1px_0_0_#1e40af]",
};

/* ═══════════════ Component ═══════════════ */

export function ExamCalculator({ open, mode, onClose }: Props) {
  const [atoms, setAtoms] = useState<Atom[]>([]);
  const [cursor, setCursor] = useState<Cursor>(emptyCursor());
  const [result, setResult] = useState("0");
  const [finalized, setFinalized] = useState(false);
  const [error, setError] = useState(false);
  const [angle, setAngle] = useState<AngleMode>("DEG");
  const [shift, setShift] = useState(false);
  const [panel, setPanel] = useState<null | "menu" | "conv" | "matrix">(null);
  const persistKey = useMemo(() => {
    try {
      const uid = window.sessionStorage.getItem("d4_calc_uid") || "local";
      return `d4_exam_calc_state_v1:${uid}`;
    } catch {
      return "d4_exam_calc_state_v1:local";
    }
  }, []);

  const [memory, setMemory] = useState(0);
  const [ans, setAns] = useState(0);
  const [pressed, setPressed] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Persist calculator state across close/reopen during exam
  useEffect(() => {
    if (!open) return;
    try {
      const raw = sessionStorage.getItem(persistKey);
      if (!raw) return;
      const s = JSON.parse(raw) as {
        atoms?: Atom[];
        result?: string;
        ans?: number;
        memory?: number;
        angle?: AngleMode;
        cursor?: Cursor;
      };
      if (Array.isArray(s.atoms)) setAtoms(s.atoms);
      if (typeof s.result === "string") setResult(s.result);
      if (typeof s.ans === "number") setAns(s.ans);
      if (typeof s.memory === "number") setMemory(s.memory);
      if (s.angle === "DEG" || s.angle === "RAD" || s.angle === "GRAD") setAngle(s.angle);
      if (s.cursor) setCursor(s.cursor);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, persistKey]);

  useEffect(() => {
    if (!open) return;
    try {
      sessionStorage.setItem(
        persistKey,
        JSON.stringify({ atoms, result, ans, memory, angle, cursor }),
      );
    } catch {
      /* ignore */
    }
  }, [atoms, result, ans, memory, angle, cursor, open, persistKey]);

  // Do NOT clear expression on close — state persists for the exam session via sessionStorage.
  useEffect(() => {
    if (!open) {
      setShift(false);
      setPanel(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onCustom = () => onClose();
    window.addEventListener("d4-close-calculator", onCustom);
    try {
      (window as unknown as { __d4CloseCalc?: () => void }).__d4CloseCalc = onClose;
    } catch {
      /* */
    }
    let handle: { remove: () => Promise<void> } | null = null;
    let cancelled = false;
    if (isNativeShell()) {
      void (async () => {
        try {
          handle = await CapApp.addListener("backButton", () => onClose());
          if (cancelled) await handle?.remove();
        } catch {
          /* */
        }
      })();
    }
    return () => {
      cancelled = true;
      window.removeEventListener("d4-close-calculator", onCustom);
      try {
        delete (window as unknown as { __d4CloseCalc?: () => void }).__d4CloseCalc;
      } catch {
        /* */
      }
      void handle?.remove();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (finalized) return;
    if (!atoms.length) {
      setResult("0");
      setError(false);
      return;
    }
    try {
      const v = evalAtoms(atoms, angle, ans);
      if (Number.isFinite(v)) {
        setResult(formatResult(v));
        setError(false);
      }
    } catch {
      /* */
    }
  }, [atoms, angle, finalized, ans]);

  const apply = useCallback(
    (action: string) => {
      // click feedback
      setPressed(action);
      window.setTimeout(() => setPressed(null), 120);
      try {
        if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(12);
      } catch {
        /* */
      }

      setError(false);
      if (
        finalized &&
        !["=", "AC", "BKSP", "LEFT", "RIGHT", "SHIFT", "DRG", "MR", "M+", "M-", "MENU"].includes(action)
      ) {
        setFinalized(false);
        if (/^[0-9.]$/.test(action)) {
          setAtoms([{ t: "num", v: action }]);
          setCursor(emptyCursor());
          return;
        }
        setAtoms([]);
        setCursor(emptyCursor());
      }

      if (action === "SHIFT") {
        setShift((s) => !s);
        return;
      }
      if (action === "AC") {
        setAtoms([]);
        setCursor(emptyCursor());
        setResult("0");
        setFinalized(false);
        setShift(false);
        setError(false);
        try {
          sessionStorage.setItem(persistKey, JSON.stringify({ atoms: [], result: "0", ans, memory, angle, cursor: emptyCursor() }));
        } catch { /* */ }
        return;
      }
      if (action === "BKSP") {
        const r = backspace(atoms, cursor);
        setAtoms(r.atoms);
        setCursor(r.cur);
        setFinalized(false);
        return;
      }
      if (action === "LEFT" || action === "RIGHT") {
        if (atoms.length) {
          const lastIdx = atoms.length - 1;
          const last = atoms[lastIdx]!;
          if (last.t === "frac") {
            setCursor({
              path: [lastIdx],
              slot: action === "RIGHT" ? (cursor.slot === "num" ? "den" : "num") : cursor.slot === "den" ? "num" : "den",
            });
            return;
          }
          if (last.t === "mixed") {
            const order: Slot[] = ["whole", "num", "den"];
            const i = Math.max(0, order.indexOf(cursor.slot));
            const next = order[(i + (action === "RIGHT" ? 1 : 2)) % 3]!;
            setCursor({ path: [lastIdx], slot: next });
            return;
          }
          if (last.t === "sqrt" || last.t === "cbrt" || last.t === "fn") {
            setCursor({ path: [lastIdx], slot: "arg" });
            return;
          }
          if (last.t === "pow") {
            setCursor({ path: [lastIdx], slot: cursor.slot === "exp" ? "base" : "exp" });
            return;
          }
          if (last.t === "nroot") {
            setCursor({ path: [lastIdx], slot: cursor.slot === "n" ? "arg" : "n" });
            return;
          }
        }
        setCursor(emptyCursor());
        return;
      }
      if (action === "DRG") {
        setAngle((a) => (a === "DEG" ? "RAD" : a === "RAD" ? "GRAD" : "DEG"));
        return;
      }
      if (action === "MENU") { setPanel("menu"); return; }
      if (action === "CONV") { setPanel("conv"); return; }
      if (action === "MATRIX") { setPanel("matrix"); return; }
      if (action === "NOP") return;
      if (action === "MR") {
        const r = insertAt(atoms, cursor, { t: "num", v: formatResult(memory) });
        setAtoms(r.atoms);
        setCursor(r.cur);
        return;
      }
      if (action === "M+") {
        try {
          const v = evalAtoms(atoms, angle, ans);
          if (Number.isFinite(v)) setMemory((m) => m + v);
        } catch {
          /* */
        }
        return;
      }
      if (action === "M-") {
        try {
          const v = evalAtoms(atoms, angle, ans);
          if (Number.isFinite(v)) setMemory((m) => m - v);
        } catch {
          /* */
        }
        return;
      }
      if (action === "=") {
        try {
          const v = evalAtoms(atoms, angle, ans);
          if (!Number.isFinite(v)) {
            setError(true);
            setResult("Error");
            return;
          }
          setAns(v);
          setResult(formatResult(v));
          setFinalized(true);
          setAtoms([{ t: "num", v: formatResult(v) }]);
          setCursor(emptyCursor());
        } catch {
          setError(true);
          setResult("Error");
        }
        return;
      }
      if (action === "rand") {
        const r = insertAt(atoms, cursor, { t: "num", v: Math.random().toFixed(6) });
        setAtoms(r.atoms);
        setCursor(r.cur);
        return;
      }
      if (action === "neg") {
        const list = [...getListAt(atoms, cursor)];
        if (list.length && list[list.length - 1]!.t === "num") {
          const n = list[list.length - 1] as { t: "num"; v: string };
          n.v = n.v.startsWith("-") ? n.v.slice(1) : `-${n.v}`;
          setAtoms(setListAt(atoms, cursor, list));
        } else {
          const r = insertAt(atoms, cursor, { t: "op", v: "−" });
          setAtoms(r.atoms);
          setCursor(r.cur);
        }
        return;
      }
      if (action === "EXP") {
        // ×10^
        let r = insertAt(atoms, cursor, { t: "op", v: "×" });
        r = insertAt(r.atoms, r.cur, { t: "fn", name: "10^", arg: [] });
        setAtoms(r.atoms);
        setCursor(r.cur);
        setShift(false);
        return;
      }

      let item: Atom | null = null;
      if (/^[0-9]$/.test(action)) item = { t: "num", v: action };
      else if (action === ".") item = { t: "num", v: "." };
      else if (["+", "−", "×", "÷"].includes(action)) item = { t: "op", v: action };
      else if (action === "(") item = { t: "lparen" };
      else if (action === ")") item = { t: "rparen" };
      else if (action === "%") item = { t: "pct" };
      else if (action === "fact") item = { t: "fact" };
      else if (action === "pi") item = { t: "pi" };
      else if (action === "e") item = { t: "e" };
      else if (action === "ans") item = { t: "ans" };
      else if (action === "x" || action === "y") item = { t: "x" };
      else if (action === "i") item = { t: "i" };
      else if (action === "frac") item = { t: "frac", num: [], den: [] };
      else if (action === "mixed") item = { t: "mixed", whole: [], num: [], den: [] };
      else if (action === "sqrt") item = { t: "sqrt", arg: [] };
      else if (action === "cbrt") item = { t: "cbrt", arg: [] };
      else if (action === "nroot") item = { t: "nroot", n: [], arg: [] };
      else if (action === "pow") item = { t: "pow", base: [], exp: [] };
      else if (action === "sq") item = { t: "sq", base: [] };
      else if (action === "cube") item = { t: "cube", base: [] };
      else if (action === "inv") item = { t: "inv", base: [] };
      else if (
        ["sin", "cos", "tan", "asin", "acos", "atan", "ln", "log", "abs", "exp"].includes(action)
      )
        item = { t: "fn", name: action === "log" ? "log" : action, arg: [] };
      else if (action === "tenx") item = { t: "fn", name: "10^", arg: [] };
      else if (action === "nCr") item = { t: "nCr", n: [], r: [] };
      else if (action === "nPr") item = { t: "nPr", n: [], r: [] };
      else if (action === "mod") item = { t: "mod", a: [], b: [] };
      else if (action === "abs") item = { t: "abs", arg: [] };
      else if (action === "sum") item = { t: "sum", lo: [], hi: [], body: [] };
      else if (action === "integral") item = { t: "integral", lo: [], hi: [], body: [] };
      else if (action === "deriv") item = { t: "deriv", body: [], at: [] };
      else return;

      const r = insertAt(atoms, cursor, item);
      setAtoms(r.atoms);
      setCursor(r.cur);
      setShift(false);
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollLeft = el.scrollWidth;
      });
    },
    [atoms, cursor, finalized, angle, ans, memory],
  );

  const rows = useMemo(() => (mode === "basic" ? basicRows() : scientificRows()), [mode]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="d4-exam-calc fixed z-[2147483000] flex flex-col overflow-hidden"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        inset: 0,
        width: "100%",
        height: "100%",
        minWidth: "100%",
        minHeight: "100%",
        margin: 0,
        background: "linear-gradient(180deg, #071428 0%, #0b1b3a 42%, #050d1c 100%)",
        // StatusBar does not overlay the WebView — do not add extra safe-area
        // padding or the calculator looks inset / cut off.
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        paddingRight: 0,
        boxSizing: "border-box",
      }}
      role="dialog"
      aria-modal
      aria-label="Scientific Calculator"
    >
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-sky-500/15 ring-1 ring-sky-400/40">
            <CalcIcon className="h-5 w-5 text-sky-400" />
          </div>
          <div className="min-w-0">
            <p className="text-[15px] font-extrabold leading-tight tracking-wide text-white">
              D<span className="text-sky-400">4</span>EXAM
            </p>
            <p className="text-[10px] font-semibold tracking-wide text-slate-400">
              {mode === "scientific" ? "Scientific Calculator" : "Calculator"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => apply("DRG")}
            className="rounded-full bg-[#2563eb] px-3 py-1.5 text-[11px] font-bold tracking-wide text-white shadow-lg shadow-blue-900/40"
          >
            {angle}
          </button>
          <span
            className={cn(
              "rounded-full px-3 py-1.5 text-[11px] font-bold tracking-wide",
              memory !== 0 ? "bg-[#2563eb] text-white shadow-lg shadow-blue-900/40" : "bg-[#1e3a5f] text-slate-300",
            )}
          >
            M
          </span>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-full bg-[#1e3a5f] text-white shadow-md transition hover:bg-[#2a4a75] active:scale-95"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* Display */}
      <div
        ref={scrollRef}
        className="mx-2 shrink-0 overflow-x-auto rounded-2xl border border-[#1e4a8c] bg-[#050d1c] px-3.5 py-3.5 shadow-[inset_0_2px_18px_rgba(0,0,0,0.7),0_0_0_1px_rgba(56,189,248,0.2),0_0_32px_rgba(30,64,140,0.45)]"
        style={{ minHeight: "6.75rem" }}
        onClick={() => setCursor(emptyCursor())}
      >
        <div className="min-h-[2.4rem] whitespace-nowrap text-left">
          {atoms.length === 0 ? (
            <span className="inline-flex items-center">
              <Caret on />
            </span>
          ) : (
            <AtomRow atoms={atoms} cursor={cursor} onCursor={setCursor} />
          )}
        </div>
        <div
          className={cn(
            "mt-2 text-right font-mono text-[2rem] font-extrabold tabular-nums leading-none sm:text-[2.35rem]",
            error ? "text-red-400" : "text-white",
          )}
        >
          {result}
        </div>
      </div>

      {shift ? (
        <div className="px-3 pt-1 text-center text-[10px] font-bold tracking-widest text-emerald-400">
          SHIFT
        </div>
      ) : (
        <div className="h-3" />
      )}


      {panel ? (
        <div className="mx-2 mb-2 max-h-[40%] overflow-y-auto rounded-xl border border-sky-500/30 bg-[#06101f]/95 p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wider text-sky-300">
              {panel === "menu" ? "Menu" : panel === "conv" ? "Conversion" : "Matrix"}
            </p>
            <button type="button" className="text-xs font-semibold text-slate-400 hover:text-white" onClick={() => setPanel(null)}>
              Close
            </button>
          </div>
          {panel === "menu" ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[
                ["Fraction", "frac"],
                ["Mixed", "mixed"],
                ["Σ Sum", "sum"],
                ["∫ Integral", "integral"],
                ["d/dx", "deriv"],
                ["√ Root", "sqrt"],
                ["nCr", "nCr"],
                ["nPr", "nPr"],
                ["Matrix", "MATRIX"],
                ["Convert", "CONV"],
              ].map(([lab, act]) => (
                <button
                  key={lab}
                  type="button"
                  className="rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-left text-[11px] font-semibold text-white hover:bg-white/10"
                  onClick={() => {
                    setPanel(null);
                    apply(act);
                  }}
                >
                  {lab}
                </button>
              ))}
            </div>
          ) : null}
          {panel === "conv" ? <ConvPanel onUse={(v) => {
            setPanel(null);
            const r = insertAt(atoms, cursor, { t: "num", v: formatResult(v) });
            setAtoms(r.atoms);
            setCursor(r.cur);
            setResult(formatResult(v));
          }} /> : null}
          {panel === "matrix" ? (
            <p className="text-xs leading-relaxed text-slate-400">
              Matrix tools: use numbers and parentheses for 2×2 operations. Full grid editor expands in a future update.
              Determinant example: enter elements then compute manually, or use MENU → Matrix after selecting values.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Keypad */}
      <div className="flex min-h-0 flex-1 flex-col gap-[5px] overflow-y-auto px-2 pb-2 pt-1">
        {rows.map((row, ri) => {
          const cols = row.reduce((a, k) => a + (k.span || 1), 0);
          return (
            <div
              key={ri}
              className="grid flex-1 gap-[4px]"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {row.map((k, ki) => {
                const useShift = Boolean(shift && k.shiftAction);
                const act = useShift && k.shiftAction ? k.shiftAction : k.action;
                const isPressed = pressed === act || pressed === k.action;
                return (
                  <button
                    key={`${ri}-${ki}`}
                    type="button"
                    onClick={() => apply(act)}
                    className={cn(
                      "relative flex min-h-[2.55rem] flex-col items-center justify-center rounded-[14px] text-[13px] font-bold tracking-tight transition-transform duration-75 select-none sm:min-h-[2.7rem] sm:text-[14px]",
                      TONE[k.tone],
                      k.tone === "shift" && shift && "from-emerald-300 to-emerald-500 ring-2 ring-emerald-200/50",
                      isPressed && "scale-[0.96] brightness-110",
                    )}
                    style={k.span ? { gridColumn: `span ${k.span}` } : undefined}
                  >
                    <span className="leading-none">{useShift && k.sub ? k.sub : k.label}</span>
                    {!useShift && k.sub ? (
                      <span className="mt-0.5 text-[7.5px] font-medium leading-none text-sky-200/55">{k.sub}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}


const CONV_UNITS: Record<string, { label: string; toBase: (v: number) => number; fromBase: (v: number) => number }[]> = {
  Length: [
    { label: "m", toBase: (v) => v, fromBase: (v) => v },
    { label: "km", toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
    { label: "cm", toBase: (v) => v / 100, fromBase: (v) => v * 100 },
    { label: "mm", toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
    { label: "in", toBase: (v) => v * 0.0254, fromBase: (v) => v / 0.0254 },
    { label: "ft", toBase: (v) => v * 0.3048, fromBase: (v) => v / 0.3048 },
    { label: "yd", toBase: (v) => v * 0.9144, fromBase: (v) => v / 0.9144 },
    { label: "mi", toBase: (v) => v * 1609.344, fromBase: (v) => v / 1609.344 },
  ],
  Mass: [
    { label: "kg", toBase: (v) => v, fromBase: (v) => v },
    { label: "g", toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
    { label: "mg", toBase: (v) => v / 1e6, fromBase: (v) => v * 1e6 },
    { label: "lb", toBase: (v) => v * 0.45359237, fromBase: (v) => v / 0.45359237 },
    { label: "oz", toBase: (v) => v * 0.028349523125, fromBase: (v) => v / 0.028349523125 },
  ],
  Temperature: [
    { label: "°C", toBase: (v) => v, fromBase: (v) => v },
    { label: "°F", toBase: (v) => (v - 32) * (5 / 9), fromBase: (v) => v * (9 / 5) + 32 },
    { label: "K", toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
  ],
  Time: [
    { label: "s", toBase: (v) => v, fromBase: (v) => v },
    { label: "ms", toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
    { label: "min", toBase: (v) => v * 60, fromBase: (v) => v / 60 },
    { label: "h", toBase: (v) => v * 3600, fromBase: (v) => v / 3600 },
    { label: "day", toBase: (v) => v * 86400, fromBase: (v) => v / 86400 },
  ],
  Angle: [
    { label: "deg", toBase: (v) => v, fromBase: (v) => v },
    { label: "rad", toBase: (v) => (v * 180) / Math.PI, fromBase: (v) => (v * Math.PI) / 180 },
    { label: "grad", toBase: (v) => (v * 9) / 10, fromBase: (v) => (v * 10) / 9 },
  ],
  Data: [
    { label: "B", toBase: (v) => v, fromBase: (v) => v },
    { label: "KB", toBase: (v) => v * 1024, fromBase: (v) => v / 1024 },
    { label: "MB", toBase: (v) => v * 1048576, fromBase: (v) => v / 1048576 },
    { label: "GB", toBase: (v) => v * 1073741824, fromBase: (v) => v / 1073741824 },
  ],
};

function ConvPanel({ onUse }: { onUse: (v: number) => void }) {
  const cats = Object.keys(CONV_UNITS);
  const [cat, setCat] = useState(cats[0]!);
  const units = CONV_UNITS[cat]!;
  const [fromI, setFromI] = useState(0);
  const [toI, setToI] = useState(1);
  const [val, setVal] = useState("1");
  const from = units[fromI] ?? units[0]!;
  const to = units[toI] ?? units[1] ?? units[0]!;
  const num = Number(val);
  const out = Number.isFinite(num) ? to.fromBase(from.toBase(num)) : NaN;
  return (
    <div className="space-y-2 text-xs text-white">
      <select className="w-full rounded-lg border border-white/15 bg-white/10 px-2 py-1.5" value={cat} onChange={(e) => { setCat(e.target.value); setFromI(0); setToI(1); }}>
        {cats.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-slate-400">From</span>
          <select className="w-full rounded-lg border border-white/15 bg-white/10 px-2 py-1.5" value={fromI} onChange={(e) => setFromI(Number(e.target.value))}>
            {units.map((u, i) => <option key={u.label} value={i}>{u.label}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-slate-400">To</span>
          <select className="w-full rounded-lg border border-white/15 bg-white/10 px-2 py-1.5" value={toI} onChange={(e) => setToI(Number(e.target.value))}>
            {units.map((u, i) => <option key={u.label} value={i}>{u.label}</option>)}
          </select>
        </label>
      </div>
      <input type="number" className="w-full rounded-lg border border-white/15 bg-white/10 px-2 py-1.5" value={val} onChange={(e) => setVal(e.target.value)} placeholder="Value" />
      <p className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-2 py-2 text-sm font-bold tabular-nums">
        {Number.isFinite(out) ? formatResult(out) : "—"}
      </p>
      <button type="button" disabled={!Number.isFinite(out)} className="w-full rounded-lg bg-blue-600 py-2 font-bold disabled:opacity-40" onClick={() => onUse(out)}>
        Use result
      </button>
    </div>
  );
}


export function ExamCalculatorFab({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Calculator"
      title="Calculator"
      className={cn(
        "fixed z-[2147482500] grid h-12 w-12 place-items-center rounded-full bg-[#2563eb] text-white shadow-lg shadow-blue-900/40 transition hover:bg-[#1d4ed8] active:scale-95",
        "left-[max(0.75rem,env(safe-area-inset-left))]",
        "bottom-[max(0.75rem,env(safe-area-inset-bottom))]",
      )}
    >
      <CalcIcon className="h-5 w-5" />
    </button>
  );
}
