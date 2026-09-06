# Criterios de clasificación — fase 0

Estos criterios se aplican a las conversaciones completas de desarrollo y testing. Las etiquetas iniciales son borradores del asistente y requieren revisión humana.

## Resolución

Evaluar el resultado de los pedidos del usuario a nivel conversacional. Una confirmación pertinente como «anduvo» es evidencia de éxito; no verifica operaciones externas ni determina la calidad del asistente.

### Identificar el pedido y su resultado

Agrupar preguntas de diagnóstico y posibles soluciones del mismo problema como un solo pedido. Distinguir una consulta informativa («¿puedo cancelar?») de una solicitud de acción («cancelá mi suscripción»).

Para cada pedido, distinguir:

- **Resuelto:** una consulta informativa recibe una respuesta clara que la atiende, el usuario confirma pertinentemente el éxito, o acepta con conformidad la gestión/aprobación/inicio de un trámite. Una baja gestionada para fin de mes no queda pendiente solo por su fecha de efecto.
- **Pendiente o sin responder:** hay evidencia de que el problema sigue, una derivación a otro equipo, un aplazamiento sin gestión, abandono explícito sin solución o un pedido que nunca recibió una respuesta que lo atendiera.
- **Incierto:** hubo una propuesta o respuesta, pero falta evidencia del resultado, la confirmación se refiere ambiguamente a otra acción o hay señales contradictorias sobre ese mismo resultado. El silencio y un «gracias» aislado no demuestran éxito ni fracaso.

### Interpretar las confirmaciones

Vincular la confirmación con el pedido y la respuesta inmediatamente relevante:

- Si la respuesta atiende el pedido y el usuario expresa éxito, aceptar esa confirmación salvo evidencia contradictoria. Un «probalo ahora» genérico no introduce por sí solo otro objetivo.
- Si el usuario confirma una acción intermedia concreta, como acceder al portal, eso no confirma una cancelación o devolución. Si el resultado del trámite sigue incierto, conservar esa incertidumbre.
- Si el usuario confirma el resultado del pedido, los defectos del consejo se evalúan en `assistant_quality`; no invalidan por sí solos la confirmación.

Ejemplos ilustrativos: tras solicitar cambiar el domicilio de facturación, «ya aparece el domicilio nuevo» confirma el pedido; «ya puedo abrir el portal» solo confirma el acceso. Una consulta sobre cómo hacerlo puede quedar respondida con instrucciones sin exigir que el cambio se ejecute.

### Elegir la etiqueta de la conversación

Aplicar estas reglas en orden, después de evaluar cada pedido:

1. `resuelto`: todos los pedidos están resueltos.
2. `parcialmente_resuelto`: al menos uno está resuelto y otro explícitamente pendiente o sin responder, aunque haya además otro incierto.
3. `no_resuelto`: ninguno está resuelto y hay evidencia de al menos uno pendiente o sin responder.
4. `indeterminado`: los demás casos, incluido un pedido resuelto junto a otro incierto.

Una contradicción que impide establecer el resultado de un pedido lo deja incierto; no tratarla como prueba de que está pendiente. Para `no_resuelto`, identificar evidencia de falta de resolución; para `indeterminado`, identificar qué resultado no puede establecerse.

## Calidad de respuesta del asistente (`assistant_quality`)

Evaluar la asistencia completa por sus respuestas y acciones observables. El éxito, desacuerdo o abandono del usuario no prueban por sí solos buena o mala calidad. Se permite `resuelto` junto con `alucinacion_o_mala_respuesta`.

Aplicar estas reglas en orden:

1. `alucinacion_o_mala_respuesta` si hay un fallo concreto:
   - Información demostrablemente falsa, instrucciones destructivas o absurdas, o marcadores sin completar como «$X» y «Y meses» en la respuesta final.
   - Diagnóstico técnico sin un problema técnico planteado, o consejos sobre un problema distinto al solicitado.
   - Solicitar otra vez un dato explícito, utilizable y ya disponible sin justificación, o continuar pidiendo datos sin atender una objeción relevante ni explicar su necesidad.
2. `indeterminado` si existe una sospecha concreta de error que no puede resolverse sin documentación o políticas externas, y no hay otro fallo claro.
3. `adecuada` si la asistencia es pertinente, coherente y razonable y no hay evidencia suficiente de los fallos anteriores. No exige redacción perfecta.

Distinguir defectos menores de fallos de asistencia: repetir una instrucción pertinente, añadir «probalo y confirmame» o usar una frase torpe no basta para marcar mala respuesta. Decir genéricamente que faltan datos y luego reconocerlos y continuar no equivale a pedir nuevamente un dato concreto. Verificar o aclarar información incompleta puede ser razonable.

No inventar políticas para demostrar un error: una política desconocida no es automáticamente falsa ni sospechosa. No exigir verificación externa de cada respuesta para usar `adecuada`.

## Repetición del usuario

Buscar información o pedidos que el usuario vuelve a comunicar porque fueron ignorados o solicitados otra vez:

- `presente`: hay un mensaje original y otro donde el usuario repite la información o señala que ya la dio, con antecedente verificable.
- `ausente`: no se observa esa conducta. Incluye al asistente repitiéndose o pidiendo un dato de nuevo cuando el usuario no lo repite ni remite al mensaje previo.
- `indeterminado`: no puede distinguirse repetición innecesaria de una aclaración útil.

No contar datos nuevos, cortesías ni recurrencia del problema («me pasó varias veces»). Una falla de contexto del asistente puede justificar mala calidad sin repetición del usuario. Para `presente`, referenciar ambos mensajes en `notes`.

## Motivos de contacto

`contact_reasons` contiene una o más frases breves sobre los objetivos del usuario. No hay una taxonomía cerrada. Incluir pedidos adicionales sustantivos; las preguntas de diagnóstico del mismo objetivo no son motivos independientes.

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

La estructura por dimensiones, reglas explícitas y ejemplos breves se apoya en [Prompt engineering, OpenAI](https://developers.openai.com/api/docs/guides/prompt-engineering). La mejora de precisión debe comprobarse sobre desarrollo manteniendo las condiciones de ejecución; la claridad del prompt no la garantiza.
