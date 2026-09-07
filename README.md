# Agente de análisis de conversaciones

Agente para que un equipo de producto entienda, a escala, qué pasa en las conversaciones de un bot de soporte: temas recurrentes, fallos, frustración y qué se podría mejorar.

El usuario hace preguntas en lenguaje natural (y follow-ups) y el agente consulta un dataset ya analizado. No recorre las ~5.000 conversaciones en cada pregunta: primero las clasifica y las indexa; después combina **métricas sobre etiquetas** con **búsqueda en el texto**.

## Cómo funciona

1. **Importación.** Se leen las conversaciones del JSON, un modelo las etiqueta (resolución, repetición, calidad del asistente, motivos de contacto) y se guardan en SQLite junto con índices de texto y vectores.
2. **Pregunta.** Un orquestador (LLM) elige herramientas:
   - **SQL** para conteos, porcentajes, rankings y filtros sobre etiquetas ya guardadas.
   - **Búsqueda** cuando hace falta leer mensajes (temas, frustración, errores del asistente).
3. **Respuesta.** Debe apoyarse en evidencia (IDs de conversación y, si describe contenido, mensajes reales). La búsqueda devuelve candidatos, no el corpus entero: si piden un porcentaje global de un tema nuevo, el agente debe decir que no puede garantizarlo sin un análisis exhaustivo.

La interacción es por **CLI**. Cada `bun run ask` es una pregunta; el historial entre preguntas de sesión aún no está persistido.

## Stack

| Pieza | Para qué |
| --- | --- |
| **Bun** (≥ 1.4.2) + TypeScript | Runtime y tests. No hace falta Node ni Python. |
| **SQLite** | Una base local con conversaciones, etiquetas y búsqueda. |
| **FTS5** | Búsqueda por palabras (tipo “passkey”). |
| **sqlite-vec** | Búsqueda semántica (parecido de significado, no solo palabras exactas). |
| **OpenAI** | Clasificación, embeddings y el modelo que orquesta la pregunta. |
| **Zod** | Validar JSON de entrada y salidas estructuradas del modelo. |

En macOS el SQLite del sistema no carga extensiones: `brew install sqlite`. En Apple Silicon se usa `/opt/homebrew`; en Intel, `/usr/local`. Si está en otro lado, `SQLITE_LIBRARY_PATH` apunta al `.dylib`.

## Cómo correrlo

```bash
bun install
```

Creá un `.env` con `OPENAI_API_KEY`. Opcional: `OPENAI_MODEL`, `OPENAI_EMBEDDING_MODEL` (por defecto `text-embedding-3-small`).

Actualizar Bun: `bun upgrade`.

### 1. Importar el dataset

```bash
bun run data:import
```

Lee `challenge-dataset.json` y escribe `data/conversations.sqlite` (archivo local, no va a Git). Otro archivo:

```bash
bun run data:import data/development.json
```

La clasificación llama a la API y puede tardar. Si un lote falla, no se guarda; al reintentar se reutiliza lo que ya está completo.

### 2. Preguntar al agente

```bash
bun run ask "¿Cuántas conversaciones quedaron resueltas?"
bun run ask "Mostrame los 5 tópicos principales, su cantidad y porcentaje de resolución"
bun run ask "Mostrame conversaciones sobre passkeys que estén resueltas"
```

En la terminal se ven las herramientas que usó el modelo y la respuesta final.

### 3. Búsqueda directa (sin el orquestador)

Útil para inspeccionar el índice, no para métricas globales.

```bash
bun run search:text "passkey" 10
bun run search:vector "problemas para iniciar sesión sin contraseña" 10
bun run search:hybrid "problemas para configurar o usar passkeys" 5 passkey passkeys
```

- **Texto:** palabras literales (todas deben aparecer).
- **Vector:** necesita API (embedding de la consulta).
- **Híbrido:** mezcla ambos. Palabras clave opcionales al final; sin ellas, solo vector.

### 4. Tests

```bash
bun test
bun run typecheck
bun run test:integration
```

Los tests normales no gastan API. Los de integración sí (`OPENAI_API_KEY`) y usan la base de development en solo lectura. Un caso concreto:

```bash
bun run test:integration --test-name-pattern 'moneda ya indicada'
```

## Decisiones de diseño

**Clasificar una vez, consultar muchas.** Recorrer 5.000 hilos con un LLM en cada pregunta no escala ni es comparable entre corridas. En la importación se guardan etiquetas (resolución, calidad, motivos) y también embeddings de cada conversación. En cada pregunta el modelo no relee el corpus: elige entre dos herramientas.

**Dos herramientas.**
- **Búsqueda** (híbrida): combina texto (palabras exactas) y vectores (parecido de significado). Sirve para temas, fallos o palabras claves que hay que ver en los mensajes. Devuelve candidatos; el modelo debe leerlos antes de afirmar. Un acotado número de resultados no es un porcentaje del dataset.
- **SQL:** el modelo escribe la query; la app la ejecuta en solo lectura, con esquema acotado y límites de tiempo y filas. Sirve para conteos, tasas y filtros sobre etiquetas ya guardadas. 

**SQL en un proceso separado.** Una query generada por el modelo puede ser válida y de solo lectura, pero muy costosa. Como SQLite se ejecuta de forma sincrónica, separarla permite mantener disponible el proceso principal y terminar el proceso SQL si supera los 5 segundos; un temporizador en el mismo proceso no podría interrumpir una consulta bloqueante. El costo es crear un proceso y abrir una conexión por llamada.

**Motivos exactos vs tópicos.** Los motivos se guardan tal cual. Si piden “tópicos”, el modelo lista los motivos, propone un mapeo revisable y recién ahí calcula métricas. Agrupar labels no es releer todo el corpus.

## Trade-offs

| Elegimos | En lugar de | Por qué |
| --- | --- | --- |
| SQLite local + CLI | App web / Elasticsearch / Postgres | Menos infra para el challenge; una máquina alcanza para este tamaño. |
| Etiquetas + búsqueda | Solo RAG en cada pregunta | Métricas estables y baratas; RAG solo donde hace falta el texto. |
| Candidatos, no exhaustivo | Clasificar on-the-fly todo el corpus | Latencia y costo; se declara el límite de cobertura. |
