# Patrimônio con juanca

La aplicación completa está en http://localhost:3040. Acceso por usuario `juanca` y contraseña guardada en `access.txt` (solo accesible por Jorge). No compartir `credentials.json`: incluye el token del MCP. Interfaz y Hermes comparten el usuario estable `juanca-family`, la base y los archivos.

Se sirve la compilación del Worker mediante Wrangler/Miniflare local, sin cuenta Cloudflare ni Docker. Este despliegue acepta el equipo y clientes de la red 192.168.68.0/24: no es un despliegue público ni un servicio de producción Cloudflare. El Worker interno en 127.0.0.1:3041 recibe cabeceras de identidad del gateway autenticado. Otros procesos del mismo usuario del equipo son de confianza. Acceso en la red local: http://nbcriancas:3040 o http://192.168.68.128:3040. HTTP no cifra el tráfico; usar solo una red de confianza. Para acceso por Internet hace falta TLS y una capa de autenticación apropiada antes de exponerlo.

## Operación

```bash
systemctl --user status patrimonio-juanca-web patrimonio-juanca-worker
systemctl --user restart patrimonio-juanca-web patrimonio-juanca-worker
systemctl --user stop patrimonio-juanca-web patrimonio-juanca-worker
```

Los servicios están habilitados para iniciar con el gestor de servicios de usuario. La disponibilidad depende de que el equipo esté encendido y el gestor de usuario esté activo.

Para recompilar después de cambios, ejecutar `./integration/build-local.sh` desde la raíz del proyecto. Las migraciones se aplican incrementalmente al almacenamiento existente.

## Datos y respaldo

`integration/state` contiene D1/SQLite y R2 local. No borrar esa carpeta ni reemplazarla al actualizar el código. Para una copia coherente, parar ambos servicios, copiar toda `integration/state` y `integration/credentials.json` a un destino privado y luego arrancar ambos servicios. Proteger la copia: contiene datos y documentos patrimoniales.

El tar original no incluye datos D1 ni documentos R2 del Site anterior. Para continuar con ese historial hace falta una exportación independiente de ambos. La identidad anterior debe mapearse a `juanca-family` después de inspeccionar la exportación. No importar SQL de producción sobre esta base sin revisar esquema, identidad y duplicados. El Site original no se ha modificado.

## Hermes

Servidor MCP `patrimonio` registrado en el config.yaml del perfil juanca; conjunto `mcp-patrimonio` habilitado en CLI y Telegram. No se modifican los otros perfiles. La guía de uso para el agente está en `skills/patrimonio/SKILL.md` del perfil.

Ejemplos de solicitudes:

- «Consulta el resumen de mi patrimonio y las revisiones pendientes».
- «Importa este XLSX de posiciones B3 para Jorge, con fecha de referencia …».
- «Prepara una propuesta: compré …».

Las propuestas quedan pendientes. Aprobar requiere una instrucción explícita sobre la propuesta; no se ejecutan órdenes en brokers. Las importaciones y registros de costo se realizan cuando el usuario los pide.

## Verificación realizada

Compilación completa y 19 pruebas originales aprobadas; interfaz y cinco endpoints de consulta devuelven HTTP 200; acceso anónimo devuelve 401. Handshake MCP real, descubrimiento de siete herramientas, consulta de resumen y rechazo de un propietario inválido. No se añadieron operaciones ficticias al patrimonio. Falta comprobar importaciones con documentos privados reales y recuperar el historial original.

Acceso Tailscale habilitado también para Jorge’s MacBook Pro (100.104.19.85). URL: http://nbcriancas:3040 o http://100.105.79.77:3040. Se mantiene contraseña y la lista explícita de equipos autorizados.

## Chat web con Juanca

La pestaña **Juanca** conecta con el agente real mediante la API nativa de sesiones de Hermes. El navegador usa `/api/hermes/chat` en el mismo servidor autenticado; el puente llama a Hermes exclusivamente en `127.0.0.1:8644`. La clave de esa API permanece en el servidor. Las sesiones de otros canales no se exponen al navegador.

El chat es compartido para la familia y separado de Telegram. Su historial se guarda en el `state.db` del perfil Hermes; `integration/state/web-chat-session.json` guarda la referencia a esa sesión. Para respaldar las conversaciones también hace falta respaldar el estado de Hermes con un método coherente para SQLite, además del almacenamiento patrimonial.

La conversación mantiene contexto después de recargar. Una consulta puede tardar mientras Juanca usa herramientas; no reenviar automáticamente mensajes cuando haya un error. La pestaña de transacciones continúa con su flujo de propuestas y aprobación. El chat nuevo admite texto; los documentos se cargan mediante las pestañas existentes.

La API del perfil se configura en `config.yaml`, bajo `gateway.api_server`; el conjunto de herramientas de `api_server` incluye el MCP patrimonio. Solo se reinició el gateway de juanca.

## Migración realizada el 5 de octubre de 2026

Se restauró el paquete `PATRIMONIO_MIGRACION_LOCAL_2026-10-05.tar.gz.enc` desde `/home/jorge/Documentos`, con hashes verificados. Se importaron 1.178 filas (18 importaciones, 1.101 registros, 9 decisiones de revisión, 45 cotizaciones, 4 mensajes y una propuesta), vinculando la identidad de origen a `juanca-family`. Los identificadores, relaciones y claves de documentos se conservaron. Se restauraron y verificaron por SHA-256 los 17 objetos R2; la referencia `chat://` es virtual y no necesita un archivo.

Validación: integridad SQLite, claves foráneas y comparación de todas las filas; dashboard, posiciones, proyecciones y chat; lectura R2 con Wrangler; deduplicación al volver a enviar un documento B3 existente; consulta mediante MCP. El dashboard incluye B3, Avenue y previsión de Jorge y Julia. No se crearon operaciones nuevas al migrar.

El estado anterior se conserva en `integration/state-before-migration-20261005` y una copia adicional en `workspace/patrimonio-migration-20261005/backup-before` del perfil. El reporte privado está en `workspace/patrimonio-migration-20261005/migration-report.json`. El historial del chat con Juanca y su referencia se conservaron.

## App móvil de Juanca (6 de octubre de 2026)

La interfaz local incluye navegación móvil, controles táctiles, campos de 16 px para evitar zoom al escribir en iPhone, iconos de instalación de 180/192/512 px, manifest de app independiente y ayuda para añadirla a la pantalla de inicio. El service worker solo maneja fallos de navegación y muestra una pantalla sin conexión; no guarda datos patrimoniales ni conversaciones en Cache Storage, ni reintenta envíos.

La versión móvil funciona en el acceso local existente: http://192.168.68.128:3040. Para instalar como PWA y utilizarla fuera de casa se preparó el origen https://nbcriancas.tailcb43eb.ts.net:8443, y **HTTPS ya está activado y verificado**. El usuario autorizó explícitamente el acceso HTTPS privado para su red Tailscale. El usuario ejecutó localmente el comando administrativo y se verificó el acceso el 6 de octubre de 2026: puerto 8443 limitado a la red Tailscale, certificado TLS válido, interfaz móvil HTTP 200, manifest e iconos HTTP 200 y consultas patrimoniales autenticadas HTTP 200. El acceso anónimo a la página, al dashboard y al historial del chat devuelve HTTP 401. La ruta existente de Funnel en el puerto 443 no se modificó.

Para utilizar el acceso HTTPS privado, conectar Tailscale en el teléfono, abrir la dirección en Safari (iPhone) o Chrome (Android), entrar con la cuenta existente y usar Compartilhar → Adicionar à Tela de Início (iPhone) o Instalar app (Android). El servidor de Juanca debe permanecer encendido. El gateway mantiene autenticación para HTML, datos y chat; solo los archivos de instalación e iconos pueden leerse sin credenciales.


## Sesiones en dispositivos (6 de octubre de 2026)

El acceso web usa una pantalla de login con el usuario y la contraseña existentes. **Lembrar neste dispositivo** está activado por defecto y mantiene la sesión durante 30 días desde el login. Sin marcarlo, la cookie dura la sesión del navegador con un límite de 12 horas en el servidor. La webapp instalada puede requerir un primer login propio, separado de Safari o Chrome. **Sair** revoca la sesión del dispositivo; la expiración devuelve al login. El cuadro HTTP Basic fue sustituido para evitar que el navegador vuelva a autenticar automáticamente después de salir.

Las sesiones sobreviven al reinicio y solo se guardan hashes de tokens aleatorios en `integration/state/browser-sessions.db` (0600). Cambiar la contraseña invalida las sesiones. El acceso HTTPS recomendado es https://nbcriancas.tailcb43eb.ts.net:8443/ y utiliza cookie `Secure`, `HttpOnly`, `SameSite=Strict`, exclusiva de Juanca y vinculada al dominio y puerto. El acceso HTTP local conserva una cookie distinta para no mezclarlo con HTTPS. Los intentos de login se limitan a diez por dirección en cinco minutos.

La autenticación Bearer del MCP/Hermes y la identidad `juanca-family` se conservan. Las cookies del gateway no se reenvían al Worker. Las mutaciones web exigen el origen exacto; login y logout también requieren una cabecera propia. Solo la pantalla de login, sus recursos y los archivos de instalación e iconos son públicos. Sin sesión, la navegación redirige a `/login` y las API responden 401 sin pedir HTTP Basic.

Pruebas aisladas, sin datos ni credenciales reales: `python3 -m unittest discover -s integration -p test_browser_sessions.py -v`.


## Modernización de Juanca (9 de octubre de 2026)

El chat principal ahora usa `/api/juanca/chat` e historial propio en `state/juanca-conversations.db`. Funciona en modo guiado, sin llamadas a Hermes; la IA libre todavía no está configurada. El puente `/api/hermes/chat` es legado opcional y Telegram conserva su integración. Las acciones financieras pasan por propuestas explícitas y aprobación; fecha y moneda son obligatorias. Consulte [implementación y validación](../docs/IMPLEMENTACION_JUANCA_F0_F2.md) y [arquitectura objetivo](../docs/ESPECIFICACIONES_JUANCA_MICROSERVICIOS.md).
