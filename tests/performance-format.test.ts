import { expect, test } from "bun:test";
import { countValue, percentageValue, tableRows } from "./performance-format";

test("ranking con columna # conserva motivo, cantidad y porcentaje", () => {
  const rows = tableRows(`
| # | Motivo literal | Cantidad | Resueltos | Denominador | % de resolución |
|---:|---|---:|---:|---:|---:|
| 1 | Consultar cuándo se renuevan los planes | 33 | 13 | 33 | 39,39% |
| 2 | Consultar si existe una aplicación para Android | 32 | 16 | 32 | 50,00% |
`);
  expect(rows).toHaveLength(2);
  expect(rows[0]![0]).toBe("Consultar cuándo se renuevan los planes");
  expect(countValue(rows[0]![1]!)).toBe(33);
  expect(percentageValue(rows[0]!.at(-1)!)).toBeCloseTo(100 * 13 / 33, 1);
  expect(countValue(rows[1]![1]!)).toBe(32);
  expect(percentageValue(rows[1]!.at(-1)!)).toBe(50);
});

test("ranking acepta porcentaje acompañado por su numerador y denominador", () => {
  const rows = tableRows(`
| Motivo exacto | Cantidad | Resolución |
|---|---:|---:|
| Consultar cómo exportar los datos | 4 | **50%** (2 de 4) |
`);
  expect(rows).toHaveLength(1);
  expect(countValue(rows[0]![1]!)).toBe(4);
  expect(percentageValue(rows[0]!.at(-1)!)).toBe(50);
  expect(percentageValue("2/4 = 50%")).toBe(50);
});

test("tabla de estados mantiene cantidad y denominador completos", () => {
  const rows = tableRows(`
| Estado | Cantidad | Total de conversaciones | Porcentaje |
|---|---:|---:|---:|
| \`no_resuelto\` | 1.513 | 5.000 | 30,26% |
`);
  expect(rows[0]![0]).toBe("no_resuelto");
  expect(countValue(rows[0]![1]!)).toBe(1513);
  expect(countValue(rows[0]![2]!)).toBe(5000);
  expect(percentageValue(rows[0]![3]!)).toBe(30.26);
});

test("la tolerancia de formato no acepta porcentajes ausentes ni ambiguos", () => {
  expect(() => percentageValue("2 de 4")).toThrow();
  expect(() => percentageValue("50% o 25%")).toThrow();
});

test("la tolerancia de formato conserva cifras incorrectas para que falle su validación", () => {
  expect(percentageValue("51% (2 de 4)")).toBe(51);
  expect(percentageValue("-5%")).toBe(-5);
  expect(percentageValue("105%")).toBe(105);
});

test("un ranking parcial sin porcentajes sigue sin cumplir el formato mínimo", () => {
  expect(tableRows(`
| Tópico agrupado | Conversaciones observadas |
|---|---:|
| Exportación de datos | 35 |
`)).toHaveLength(0);
});
