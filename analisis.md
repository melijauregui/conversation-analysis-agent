# Análisis y Perfilado del Dataset — Fase 0

Este documento consolida el perfilado empírico del dataset de conversaciones (`challenge-dataset.json`) y el estado del ground truth para la **Fase 0** del proyecto.

---

## 1. Resumen Ejecutivo del Dataset

* **Archivo analizado:** `challenge-dataset.json`
* **Total de conversaciones:** 5.000
* **Total de mensajes:** 31.811 (Usuario: 17.391, Asistente: 14.420)
* **Mensajes vacíos detectados:** 0
* **Volumen total de tokens:** **641.491 tokens** (medido con tokenizer `cl100k_base`)
* **Tiempo de procesamiento:** 0.62 segundos

---

## 2. Distribución de Tokens por Conversación

| Métrica estadística | Valor en Tokens |
| :--- | :--- |
| **Mínimo** | 49 |
| **Percentil 10 ($p_{10}$)** | 90 |
| **Percentil 25 ($p_{25}$)** | 105 |
| **Mediana ($p_{50}$)** | **125** |
| **Promedio ($\\mu$)** | **128** |
| **Percentil 75 ($p_{75}$)** | 147 |
| **Percentil 90 ($p_{90}$)** | 172 |
| **Percentil 95 ($p_{95}$)** | 189 |
| **Percentil 99 ($p_{99}$)** | 221 |
| **Máximo** | **297** |

---

## 3. Distribución de Turnos y Mensajes

| Métrica | Mensajes por Conversación |
| :--- | :--- |
| **Mínimo** | 4 mensajes |
| **Percentil 25** | 5 mensajes |
| **Mediana ($p_{50}$)** | **6 mensajes** |
| **Promedio** | **6.4 mensajes** |
| **Percentil 90** | 9 mensajes |
| **Máximo** | **17 mensajes** |

---

## 4. Análisis de Viabilidad Técnica y Ventana de Contexto

* **Conversaciones con > 2.000 tokens:** 0 (0.0%)
* **Conversaciones con > 4.000 tokens:** 0 (0.0%)
* **Conversaciones con > 8.000 tokens:** 0 (0.0%)

> [!NOTE]
> **Implicación Arquitectónica Directa:**  
> El valor máximo observado es de **297 tokens**. Dado que ninguna conversación supera el umbral de 2.000 tokens, **todas las conversaciones entran completas en una única llamada** en cualquier modelo moderno.  
> Por tanto, **no es necesario fragmentar turnos ni aplicar chunking destructivo** durante la extracción en la Fase 1. La preservación de referencias por mensaje (`M1`, `M2`...) se realiza sobre la conversación íntegra.

---

## 5. Estimación Económica de Ingestión (Fase 1)

Costo estimado para procesar el dataset completo (5.000 conversaciones / ~641.491 tokens de entrada) en una pasada de preprocesamiento y extracción con modelos actuales:

| Proveedor | Modelo | Tarifa Input (por 1M) | Costo Estimado Ingestión Total | Fuente / Método de Cotización |
| :--- | :--- | :--- | :--- | :--- |
| **OpenAI** | **GPT-5.6 Luna** | $0.200 USD | **~$0.128 USD** | [API OpenRouter (openai/gpt-5.6-luna)](https://openrouter.ai/openai/gpt-5.6-luna) |
| **OpenAI** | **GPT-5.6 Terra** | $2.000 USD | **~$1.283 USD** | [API OpenRouter (openai/gpt-5.6-terra)](https://openrouter.ai/openai/gpt-5.6-terra) |
| **OpenAI** | **GPT-5.6 Sol** | $2.000 USD | **~$1.283 USD** | [API OpenRouter (openai/gpt-5.6-sol)](https://openrouter.ai/openai/gpt-5.6-sol) |
| **OpenAI** | **GPT-6 Astra** | $10.000 USD | **~$6.415 USD** | [API OpenRouter (openai/gpt-6-astra)](https://openrouter.ai/openai/gpt-6-astra) |
| **Google** | **Gemini 2.5 Flash Lite** | $0.100 USD | **~$0.064 USD** | [API OpenRouter (google/gemini-2.5-flash-lite)](https://openrouter.ai/google/gemini-2.5-flash-lite) |
| **Google** | **Gemini 2.5 Flash** | $0.300 USD | **~$0.192 USD** | [API OpenRouter (google/gemini-2.5-flash)](https://openrouter.ai/google/gemini-2.5-flash) |
| **Anthropic** | **Claude 3 Haiku** | $0.250 USD | **~$0.160 USD** | [API OpenRouter (anthropic/claude-3-haiku)](https://openrouter.ai/anthropic/claude-3-haiku) |
| **Anthropic** | **Claude Sonnet 4** | $3.000 USD | **~$1.924 USD** | [API OpenRouter (anthropic/claude-sonnet-4)](https://openrouter.ai/anthropic/claude-sonnet-4) |

---

## 6. Estado del Ground Truth (Particiones de Evaluación)

Se cuenta con una muestra representativa de 100 conversaciones auditadas manualmente dividida en dos conjuntos estratificados:

### A. Partición de Desarrollo (70 casos en `data/development-labels.json`)
* **Resolución:** `resuelto`: 36 (51.4%) | `no_resuelto`: 24 (34.3%) | `indeterminado`: 6 (8.6%) | `parcialmente_resuelto`: 4 (5.7%)
* **Frustración:** `ausente`: 36 (51.4%) | `presente`: 29 (41.4%) | `indeterminado`: 5 (7.1%)
* **Repetición:** `ausente`: 67 (95.7%) | `presente`: 3 (4.3%)
* **Calidad Asistente:** `adecuada`: 56 (80.0%) | `alucinacion_o_mala_respuesta`: 14 (20.0%)

### B. Partición de Testeo Held-Out (30 casos en `data/testing-labels.json`)
* **Resolución:** `resuelto`: 16 (53.3%) | `indeterminado`: 6 (20.0%) | `no_resuelto`: 6 (20.0%) | `parcialmente_resuelto`: 2 (6.7%)
* **Frustración:** `ausente`: 15 (50.0%) | `presente`: 8 (26.7%) | `indeterminado`: 7 (23.3%)
* **Repetición:** `ausente`: 30 (100.0%)
* **Calidad Asistente:** `adecuada`: 24 (80.0%) | `alucinacion_o_mala_respuesta`: 6 (20.0%)
