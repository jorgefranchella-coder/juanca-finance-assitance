# Lectura local de enlaces documentales

`leer_enlace_documental` admite PDF por HTTPS en el puerto estándar. Valida las direcciones DNS en cada redirección y fija la conexión a una dirección validada mientras conserva la verificación TLS del nombre original. Limita redirecciones, tiempo, tamaño descargado y texto extraído; no usa proxy ni servicios externos.

El PDF se procesa en memoria y no se importa ni modifica la cartera. Leer el enlace tampoco valida la identidad del titular, la legitimidad del enlace ni el consentimiento para importar su contenido.

La extracción usa un proceso limitado y termina si el cliente cancela la operación. El resolvedor DNS usa un bloqueo seguro compartido por el usuario del sistema. La ruta efectiva prioriza `JUANCA_DNS_RUNTIME_DIR` y usa `XDG_RUNTIME_DIR` como alternativa. Si ambas faltan o la ruta elegida no es segura, la lectura falla cerrada; no cae a la alternativa cuando la ruta prioritaria está configurada pero es inválida.

El código está instalado en la copia runtime, pero la sesión MCP ya abierta no activa la herramienta hasta que se recargue la conexión MCP. La instalación de archivos por sí sola no supone un despliegue completo.
