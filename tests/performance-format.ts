import { expect } from "bun:test";

// Admitir una columna inicial de posición sin cambiar los campos del ranking.
// Los encabezados y separadores no contienen una cantidad en la segunda columna.
export function tableRows(answer: string) {
  return answer.split("\n").filter((line) => line.trim().startsWith("|"))
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|")
      .map((cell) => cell.trim().replace(/\*\*|`/g, "")))
    .map((cells) => /^\d+[.)]?$/.test(cells[0] ?? "") && !/^\d/.test(cells[1] ?? "")
      ? cells.slice(1) : cells)
    .filter((cells) => cells.length >= 3 && /^\d/.test(cells[1]!));
}

export function countValue(text: string) {
  expect(text).toMatch(/^\d+(?:[.,\s]\d{3})*$/);
  return Number(text.replace(/[.,\s]/g, ""));
}

export function percentageValue(text: string) {
  // Permitir explicaciones del cálculo: “50% (2 de 4)” o “2/4 = 50%”.
  // Debe haber un único porcentaje explícito, conservando signo y decimales.
  const matches = [...text.matchAll(/[+-]?\d+(?:[.,]\d+)?\s*%/g)];
  expect(matches.length, `Se espera un porcentaje único en: ${text}`).toBe(1);
  return Number(matches[0]![0].replace(/\s|%/g, "").replace(",", "."));
}
