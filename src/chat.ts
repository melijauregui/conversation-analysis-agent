import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
} from "@opentui/core";
import { createSession, type Session } from "./session.ts";
import { answerQuestion, type ToolCall } from "./orchestrate-question.ts";

export interface ChatOptions {
  databasePath?: string;
  session?: Session;
  renderer?: CliRenderer;
  answerQuestionFn?: (
    sessionId: string,
    question: string,
    options?: { databasePath?: string; onProgress?: (message: string) => void }
  ) => Promise<{ answer: string; calls: ToolCall[] }>;
  onExit?: () => void;
}

export interface ChatInstance {
  sessionId: string;
  renderer: CliRenderer;
  destroy: () => void;
}

export async function startChat(options: ChatOptions = {}): Promise<ChatInstance> {
  const session = options.session ?? createSession({ databasePath: options.databasePath });
  const sessionId = session.id;
  const answerFn = options.answerQuestionFn ?? answerQuestion;

  const renderer =
    options.renderer ??
    (await createCliRenderer({
      exitOnCtrlC: true,
    }));

  let isProcessing = false;

  // Contenedor principal de pantalla completa
  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  renderer.root.add(root);

  // Encabezado con sessionId y ayuda breve
  const header = new BoxRenderable(renderer, {
    border: true,
    borderStyle: "single",
    height: 3,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const headerText = new TextRenderable(renderer, {
    content: `Sesión: ${sessionId} | Comandos: /exit o Ctrl+C para salir`,
  });
  header.add(headerText);
  root.add(header);

  // Área de mensajes con scroll para el historial
  const messagesBox = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    paddingLeft: 1,
    paddingRight: 1,
  });
  root.add(messagesBox);

  // Línea de estado visible
  const statusText = new TextRenderable(renderer, {
    content: " ",
    height: 1,
    paddingLeft: 1,
    fg: "#E5C07B",
  });
  root.add(statusText);

  // Campo de entrada inferior
  const inputContainer = new BoxRenderable(renderer, {
    border: true,
    borderStyle: "single",
    height: 3,
    paddingLeft: 1,
  });
  const input = new InputRenderable(renderer, {
    placeholder: "Escribe tu consulta y presiona Enter...",
  });
  inputContainer.add(input);
  root.add(inputContainer);

  const cleanup = () => {
    if (!renderer.isDestroyed) {
      renderer.destroy();
    }
    options.onExit?.();
    if (import.meta.main) {
      process.exit(0);
    }
  };

  renderer.on("destroy", () => {
    options.onExit?.();
    if (import.meta.main) {
      process.exit(0);
    }
  });

  const sigintHandler = () => {
    cleanup();
  };
  process.once("SIGINT", sigintHandler);
  renderer.once("destroy", () => {
    process.removeListener("SIGINT", sigintHandler);
  });

  input.on("enter", async (value: string) => {
    const question = value.trim();

    // Ignorar entradas vacías o consultas concurrentes
    if (!question || isProcessing) {
      return;
    }

    // Comando de salida
    if (question.toLowerCase() === "/exit") {
      cleanup();
      return;
    }

    // Limpiar entrada inmediatamente y mostrar la pregunta
    input.value = "";
    messagesBox.add(
      new TextRenderable(renderer, {
        content: `Tú: ${question}`,
        wrapMode: "word",
        marginBottom: 1,
      })
    );

    // Estado visible de procesamiento
    isProcessing = true;
    statusText.content = "[Procesando...]";
    renderer.requestRender();

    try {
      const result = await answerFn(sessionId, question, {
        databasePath: options.databasePath,
        onProgress: (message) => {
          if (renderer.isDestroyed) return;
          statusText.content = `[${message}]`;
          renderer.requestRender();
        },
      });

      // Resumen compacto de llamadas a herramientas
      if (result.calls && result.calls.length > 0) {
        const callsSummary = `[${result.calls.map((c) => c.name).join(", ")}]`;
        messagesBox.add(
          new TextRenderable(renderer, {
            content: callsSummary,
            fg: "#888888",
            wrapMode: "word",
          })
        );
      }

      // Respuesta del asistente (incluye citas)
      messagesBox.add(
        new TextRenderable(renderer, {
          content: `Asistente: ${result.answer}`,
          wrapMode: "word",
          marginBottom: 1,
        })
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      messagesBox.add(
        new TextRenderable(renderer, {
          content: `Error: ${message}`,
          fg: "#FF5555",
          wrapMode: "word",
          marginBottom: 1,
        })
      );
    } finally {
      isProcessing = false;
      statusText.content = " ";
      renderer.requestRender();
      input.focus();
    }
  });

  input.focus();
  renderer.requestRender();

  return {
    sessionId,
    renderer,
    destroy: cleanup,
  };
}

if (import.meta.main) {
  await startChat();
}
