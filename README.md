# Agente de análisis de conversaciones

Guía para configurar el proyecto, importar conversaciones y consultar al agente desde la terminal. Las decisiones técnicas y las preguntas de arquitectura están en [decisiones-arquitectura.md](decisiones-arquitectura.md).

## 1. Configurar las variables de entorno

Ejecutá todos los comandos desde la raíz del proyecto. Si todavía no tenés `.env`, crealo a partir del ejemplo:

```bash
cp .env.example .env
```

Completá `OPENAI_API_KEY` en `.env`. Si el archivo ya existe, conservá sus valores.

- `OPENAI_API_KEY`: obligatoria para importar, preguntar y realizar búsquedas vectoriales o híbridas. También se necesita para los tests que llaman a la API.
- `DATABASE_PATH`: opcional; por defecto, `data/conversations.sqlite`. Permite elegir otra base tanto para importar como para consultar. Las rutas relativas se resuelven desde el directorio de ejecución (`/app` en Docker).
- `OPENAI_MODEL`: opcional; por defecto, `gpt-5.6-luna`. Se usa para clasificar y responder preguntas.
- `OPENAI_EMBEDDING_MODEL`: opcional; por defecto, `text-embedding-3-small`. También admite `text-embedding-3-large`.
- `OPENAI_EMBEDDING_DIMENSIONS`: opcional; por defecto, 1536 para el modelo `small` o 3072 para `large`. Debe ser un entero entre 1 y el máximo del modelo. Usá la misma configuración al importar y consultar; si la cambiás, volvé a importar el dataset.
- `SQLITE_LIBRARY_PATH`: opcional, solo para ejecución local en macOS si SQLite está fuera de las rutas habituales de Homebrew. Debe apuntar a `libsqlite3.dylib`.
- `BENCH_DATABASE_PATH`: opcional para `test:performance`; si no se define, usa la base indicada por `DATABASE_PATH` o la base por defecto.

Los scripts `test:integration` y `test:performance` activan automáticamente `RUN_DEVELOPMENT_INTEGRATION=1` y `RUN_PERFORMANCE=1`, respectivamente; no hace falta agregarlas al `.env`.

## 2. Preparar el entorno

### Con Docker

Requiere Docker con Compose y Docker iniciado. Construí la imagen:

```bash
docker compose build
```

Para ejecutar cualquiera de los comandos de Bun de esta guía dentro del contenedor, anteponé `docker compose run --rm agent`. Por ejemplo:

```bash
docker compose run --rm agent bun run data:import
```

Volvé a construir la imagen cuando cambies el código o las dependencias. Los cambios en `.env` no requieren reconstruirla. Los archivos de `data/` y `reports/` se conservan en tu máquina.

### Localmente

Requiere Bun ≥ 1.4.2. Si ya tenés una versión anterior, actualizala con `bun upgrade`.

En macOS, instalá también SQLite:

```bash
brew install sqlite
```

Instalá las dependencias:

```bash
bun install
```

## 3. Importar las conversaciones

Antes de consultar al agente, dejá `challenge-dataset.json` en la raíz y ejecutá:

```bash
bun run data:import
```

Con Docker:

```bash
docker compose run --rm agent bun run data:import
```

La ingesta lee el dataset y guarda el resultado en la base configurada. Llama a OpenAI, tiene costo y puede tardar. Si falla, repetí el comando: reutiliza las conversaciones completas cuando coinciden los datos y la configuración.

Para importar otro archivo, pasá su ruta. En Docker, guardalo dentro de `data/` para que el contenedor pueda leerlo:

```bash
bun run data:import data/development.json
```

Opciones de ingesta:

- `--database RUTA`: base de destino; tiene prioridad sobre `DATABASE_PATH`.
- `--batch-size N`: conversaciones por lote; por defecto, 5.
- `--concurrency N`: máximo de lotes simultáneos; por defecto, 100.

Ejemplo con una base separada:

```bash
bun run data:import data/development.json --database data/development.sqlite --batch-size 5 --concurrency 10
```

El archivo debe contener un objeto con un arreglo `conversations`. Cada conversación requiere `id`, `metadata` y un arreglo no vacío `messages`, con `role` (`user` o `assistant`) y `content`.

Si ya tenés una base procesada, podés omitir la ingesta y seleccionar su ruta en `.env`:

```dotenv
DATABASE_PATH=data/conversations-5000.sqlite
```

## 4. Ejecutar el agente

Abrí el chat interactivo:

```bash
bun run chat
```

Con Docker:

```bash
docker compose run --rm agent
```

Podés hacer preguntas de seguimiento dentro del chat. Para salir, usá `/exit` o Ctrl+C.

Para una pregunta puntual:

```bash
bun run ask "¿Cuántas conversaciones quedaron resueltas?"
```

## Scripts disponibles

### Uso del proyecto

- `bun run chat`: abre el chat interactivo.
- `bun run data:import [ARCHIVO]`: importa el dataset; admite las opciones de la sección de ingesta.

