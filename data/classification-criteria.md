# Criterios de clasificación — fase 0

Estos criterios se aplican a las conversaciones completas de desarrollo y testing. Las etiquetas iniciales son borradores del asistente y requieren revisión humana.

## Resolución

- `resuelto`: todos los pedidos sustantivos tienen confirmación pertinente del usuario, una respuesta informativa clara que contesta lo preguntado o la gestión/aprobación de un trámite administrativo (como reembolsos, cobros duplicados o cancelaciones) aceptada con conformidad por el usuario.
- `parcialmente_resuelto`: al menos un pedido está resuelto y otro queda explícitamente sin resolver o pendiente.
- `no_resuelto`: ningún pedido está resuelto y hay evidencia de que el problema sigue, el usuario abandona sin resolverlo o queda pendiente de otro equipo.
- `indeterminado`: falta evidencia o hay señales contradictorias que impiden establecer el resultado. También se usa cuando un pedido se resuelve, pero el resultado de otro es incierto.

Primero considerar el resultado de cada pedido; después asignar la etiqueta de la conversación. Si hay un pedido resuelto y otro explícitamente pendiente, hay evidencia suficiente de resolución parcial aunque exista además otro incierto. Si no hay pedidos resueltos y alguno está explícitamente pendiente, usar `no_resuelto`, salvo contradicciones sobre ese mismo resultado que obliguen a usar `indeterminado`.

Una pregunta como «¿cómo exporto los datos?» puede quedar respondida con instrucciones claras, sin exigir que el usuario ejecute la exportación. En cambio, ante «no puedo exportar», las instrucciones por sí solas no demuestran que el problema se haya resuelto sin confirmación del usuario.

En trámites administrativos y financieros (como reembolsos, cobros duplicados o cancelaciones), al no disponer de sistemas externos para verificar la acreditación bancaria en tiempo real, la confirmación del asistente de haber aprobado, gestionado o iniciado la devolución sumada a la expresión de conformidad del usuario («ahí probé y se solucionó», «quedo conforme», «genial, anduvo», «perfecto, quedó») se considera `resuelto` a nivel de soporte. Se diferencia de casos donde el usuario solo confirma una acción desconectada (por ejemplo, «ahora entró» que solo acredita haber iniciado sesión), donde el trámite queda aplazado («podés intentar más tarde») o donde se deriva a otro equipo (que sigue pendiente de resolución).

Un «gracias» o el silencio por sí solos no prueban resolución. Una confirmación breve sirve cuando el usuario da por cerrada la consulta con satisfacción. Una derivación aceptada a otro equipo sigue pendiente dentro de la conversación.

Las preguntas sobre posibles causas o pasos para el mismo problema no se cuentan automáticamente como pedidos independientes. Por ejemplo, «no puedo entrar, ¿pruebo otro dispositivo?» describe un mismo objetivo.

## Repetición del usuario

- `presente`: vuelve a comunicar un pedido o dato ya suministrado porque no fue atendido o se lo preguntan nuevamente. También cuenta una referencia explícita como «te lo mandé arriba» cuando se verifica el antecedente.
- `ausente`: no se observa repetición innecesaria del usuario.
- `indeterminado`: no se puede distinguir una repetición innecesaria de una aclaración útil.

Revisar el mensaje original y el repetido. No cuentan agradecimientos, datos nuevos ni repeticiones del asistente. Si el asistente pide otra vez un dato, pero el usuario no lo repite ni hace referencia a haberlo dado, registrar ese problema en notas sin marcar repetición del usuario como observada. «Es la tercera vez que me pasa» describe recurrencia del problema, no necesariamente repetición de información.

## Motivos de contacto

`contact_reasons` contiene una o más frases breves sobre lo que busca el usuario. No es todavía una taxonomía cerrada de temas. Incluir pedidos adicionales sustantivos, pero no convertir cada pregunta de diagnóstico en un tema independiente.

## Calidad de respuesta del asistente (`assistant_quality`)

Evalúa la veracidad, coherencia y pertinencia de las respuestas del asistente, independientemente del reporte de éxito del usuario. La calidad del consejo del asistente y la resolución son dimensiones distintas: una conversación puede catalogarse como `resuelto` a nivel conversacional si el usuario manifiesta conformidad, pero contener una respuesta incorrecta, engañosa o perjudicial.

- `adecuada`: las respuestas e instrucciones son pertinentes, coherentes y razonables para la consulta realizada.
- `alucinacion_o_mala_respuesta`: el asistente provee información falsa, instrucciones destructivas o absurdas (por ejemplo, borrar y recrear la cuenta para cancelar una suscripción anual), marcadores de posición sin reemplazar (como «$X» o «Y meses») o responde sobre un problema completamente desconectado de lo solicitado.
- `indeterminado`: la indicación es sospechosa o ambigua, pero no puede confirmarse como errónea sin acceso a la documentación o políticas internas del producto.

## Cómo revisar los archivos

- `development-labels.json`: 70 borradores, en el mismo orden que `development.json`.
- `testing-labels.json`: 30 borradores, en el mismo orden que `testing.json`.
- `conversation_id` vincula cada entrada con su conversación original.
- `notes` explica la decisión e indica mensajes relevantes, numerados desde **1** contando ambos roles.
- `reviewed: false` significa que falta tu revisión. Después de comprobar y corregir la entrada, cambiar a `true`. No es una etiqueta de resolución.

Las etiquetas evalúan evidencia conversacional, no verifican políticas del producto ni operaciones en sistemas externos. La calidad del consejo del asistente y la resolución son dimensiones distintas.

No usar las etiquetas de testing como ejemplos del prompt ni ajustar instrucciones para coincidir con ellas. Ambas particiones fueron anotadas por el mismo asistente con estas reglas: tu revisión es necesaria para corregir errores compartidos, y los borradores no son una evaluación independiente del modelo.

## Referencia

La práctica de definir criterios explícitos y combinar evaluación con revisión humana se describe en [Demystifying Evals for AI Agents, Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents). Las categorías y reglas concretas de este archivo son decisiones de este proyecto, no un estándar universal.
