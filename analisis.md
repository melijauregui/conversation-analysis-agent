# Rendimiento con 100, 1.000 y 5.000 conversaciones

El agente permite transformar un historial de soporte en métricas y ejemplos verificables mediante preguntas en lenguaje natural. La nueva ejecución sobre **5.000 conversaciones y 31.811 mensajes aprobó los 7 tests**, con tópicos en **18,52 s**, motivos exactos en **5,98 s** y ejemplos de repetición en **9,09 s**.

Se realizaron dos rondas por tamaño y una repetición adicional sobre 5.000 conversaciones, con `gpt-5.6-luna`. **Este resumen muestra la última ejecución de cada tamaño**, que obtuvo **7/7 PASS** en cada base.

## Tiempos de la última ejecución

Valores en segundos, con la base preparada. Incluyen modelo, herramientas e historial; el seguimiento suma dos preguntas. Cada celda corresponde a una medición, no a un promedio de las corridas.

| Operación | 100 conversaciones | 1.000 conversaciones | 5.000 conversaciones |
|---|---:|---:|---:|
| Total | 2,92 | 2,75 | 3,40 |
| Top 5 tópicos | 20,71 | 15,78 | 18,52 |
| Búsqueda y seguimiento | 9,95 | 12,58 | 14,29 |
| Ejemplos de repetición | 13,14 | 9,63 | 9,09 |
| Top 5 motivos exactos | 8,54 | 8,97 | 5,98 |
| Cantidad y porcentaje de no resueltas | 4,54 | 3,36 | 4,43 |
| Comparación resuelto / no_resuelto | 4,69 | 5,36 | 11,20 |

## Hallazgos

- **Consultas ágiles sobre miles de conversaciones.** En la última ejecución de 5.000, el agente respondió el total en **3,40 s** y los casos no resueltos en **4,43 s**, reutilizando las clasificaciones preparadas.
- **Cifras verificables.** Los totales, rankings exactos y porcentajes coincidieron con SQLite. Sobre 5.000 conversaciones se obtuvieron **2.605 resueltas (52,10%)** y **1.513 no resueltas (30,26%)**, usando toda la base como denominador.
- **Exploración con contexto.** El seguimiento filtró correctamente el conjunto anterior y los tests de repetición comprobaron la existencia de las conversaciones y mensajes citados.

Estas mediciones respaldan el uso del proyecto para explorar soporte y revisar casos concretos. La aprobación valida los controles de la suite; la calidad semántica de los tópicos y la interpretación de las citas requieren revisión.

La ingesta histórica informada fue **21,70 / 106,87 / 470,38 s** para 100 / 1.000 / 5.000 conversaciones. No se volvió a medir; esa preparación permite reutilizar etiquetas e índices.

## Fuentes

Últimas ejecuciones: [100 conversaciones](reports/performance/2026-09-08T05-20-28-421Z/) · [1.000 conversaciones](reports/performance/2026-09-08T05-21-33-000Z/) · [5.000 conversaciones](reports/performance/2026-09-08T05-34-54-621Z/).

[Resumen de las mediciones mostradas](reports/performance/latest-runs-summary.json) · [Tests y validaciones](tests/performance.test.ts).
