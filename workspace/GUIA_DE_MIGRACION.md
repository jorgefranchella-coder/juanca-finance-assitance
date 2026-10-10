# Guía para reconstruir Patrimônio en otro entorno

Este repositorio contiene el código fuente completo de la aplicación **Patrimônio — Gestão familiar**, correspondiente al commit publicado `3927e3ee2ca0178c8500e17f356ce175f222a50e` (Sites, versión 18), más esta guía de migración.

## Qué contiene

- `apps/web`: aplicación productiva React/Vinext para Cloudflare Workers.
- `apps/web/app`: interfaz y rutas API.
- `apps/web/db`: esquema D1/SQLite con Drizzle.
- `apps/web/drizzle`: todas las migraciones D1.
- `apps/web/lib`: parsers B3, Avenue y Santander, valoración y proyecciones.
- `apps/web/tests`: pruebas automatizadas.
- `apps/web/public`: favicon, imagen social y recursos estáticos.
- `apps/web/worker`: punto de entrada del Cloudflare Worker.
- `apps/web/.openai/hosting.json`: nombres lógicos de los bindings de Sites.
- `apps/api`: prototipo anterior en FastAPI/Python.
- `database`: migración PostgreSQL del prototipo anterior.
- `docs`: arquitectura y especificación funcional.
- `compose.yaml`: entorno Docker del prototipo anterior.

## Qué no contiene

El código no incluye:

- los datos privados almacenados en la base D1 de producción;
- los PDF, XLSX, imágenes u otros archivos privados almacenados en R2;
- credenciales, tokens, claves API o cookies;
- dependencias instaladas (`node_modules`, `.venv`);
- salidas de compilación (`dist`, `.next`, `.vinext`);
- estado local de Wrangler.

Esto es intencional. El código puede moverse con seguridad, pero los datos productivos requieren una exportación independiente y protegida.

## Opción recomendada: OpenAI Sites

1. Copiar el repositorio completo al nuevo workspace.
2. Mantener `apps/web/.openai/hosting.json` con los bindings lógicos:

   ```json
   {
     "project_id": "appgprj_6a8081868e68819195e5147dad2d8b3b",
     "d1": "DB",
     "r2": "UPLOADS"
   }
   ```

3. Para crear un Site diferente, registrar un proyecto nuevo y sustituir solamente el `project_id`. Conservar `DB` y `UPLOADS`, salvo que el nuevo entorno use otros nombres.
4. Desde `apps/web`, instalar dependencias, ejecutar las migraciones y publicar con el flujo de Sites.
5. Configurar la política de acceso como privada antes de cargar información patrimonial.

El `project_id` incluido identifica el Site original. No concede acceso por sí mismo ni contiene una credencial.

## Ejecución local de la aplicación productiva

Requisitos:

- Node.js 22.13 o posterior;
- npm;
- acceso de red para instalar dependencias la primera vez.

Comandos:

```bash
cd apps/web
npm ci
npm run dev
```

La aplicación se abre normalmente en `http://localhost:3000`.

El desarrollo local usa Miniflare/Cloudflare para crear bindings locales con estos nombres:

- D1: `DB`;
- R2: `UPLOADS`.

El estado local queda bajo `apps/web/.wrangler` y no debe versionarse.

## Crear el esquema local

Las migraciones están en `apps/web/drizzle` y deben aplicarse en orden:

1. `0000_old_the_anarchist.sql`
2. `0001_curved_lightspeed.sql`
3. `0002_overconfident_outlaw_kid.sql`
4. `0003_burly_firebird.sql`

El esquema de referencia está en `apps/web/db/schema.ts`.

En un despliegue distinto de Sites, crear una base D1, asociarla al binding `DB` y aplicar esas migraciones mediante Wrangler o el mecanismo de migración de la plataforma elegida.

## Almacenamiento de archivos

Crear un bucket R2 y asociarlo al binding `UPLOADS`. El sistema guarda allí:

- archivos originales de B3;
- extractos y confirmaciones Avenue;
- extractos Santander;
- anexos del chat de transacciones.

No convertir ese bucket en público. La aplicación accede a los objetos desde el Worker y los separa mediante claves ligadas al usuario.

## Autenticación

En Sites, la plataforma inyecta encabezados como:

- `oai-authenticated-user-id`;
- `oai-authenticated-user-email`;
- opcionalmente, nombre completo.

La aplicación usa el identificador estable para aislar toda consulta. Si se despliega fuera de Sites, debe implementarse una capa equivalente que:

1. autentique al visitante;
2. genere un identificador estable;
3. inyecte o adapte ese identificador antes de ejecutar las rutas API;
4. rechace peticiones anónimas a datos patrimoniales.

No publicar la aplicación fuera de Sites sin sustituir correctamente este mecanismo.

## Cotizaciones externas

No se necesitan claves API para la implementación actual:

- Brasil: archivos públicos COTAHIST de B3;
- Estados Unidos: Yahoo Finance con fallback público de Nasdaq;
- USD/BRL: PTAX del Banco Central do Brasil.

Estas fuentes públicas no tienen SLA. El nuevo entorno debe permitir solicitudes HTTPS salientes hacia ellas.

## Verificación antes de publicar

Desde `apps/web`:

```bash
npm ci
npm run build
npm run test
```

La última versión publicada había superado 19 pruebas automatizadas.

Después del despliegue, verificar al menos:

- acceso privado y autenticación;
- carga del dashboard vacío;
- importación de un archivo de prueba por cada fuente;
- deduplicación al reenviar el mismo archivo;
- creación de revisiones;
- registro manual de costo;
- cotizaciones BR y US;
- PTAX y conversión USD/BRL;
- aprobación y rechazo de propuestas del chat;
- proyección de renta fija con datos de prueba;
- aislamiento entre dos usuarios de prueba.

## Migración de datos productivos

La base D1 y el bucket R2 deben exportarse por separado desde el entorno que los aloja. La secuencia segura es:

1. poner temporalmente en pausa nuevas importaciones;
2. exportar D1 a SQL o al formato soportado por la plataforma;
3. copiar R2 preservando exactamente las claves de objeto;
4. cifrar ambos respaldos durante almacenamiento y transporte;
5. crear D1 y R2 vacíos en el destino;
6. aplicar primero las migraciones de esquema;
7. importar los datos D1;
8. restaurar los objetos R2 con las mismas claves;
9. validar conteos, hashes y muestras;
10. reactivar importaciones solamente después de la reconciliación.

Los datos patrimoniales y documentos no deben incluirse en un repositorio Git ni en un archivo compartido sin cifrado.

## Despliegue fuera de Sites

El módulo `apps/web` produce un Worker compatible con Cloudflare. Para desplegarlo directamente en Cloudflare es necesario configurar:

- assets estáticos;
- D1 en el binding `DB`;
- R2 en el binding `UPLOADS`;
- servicio de optimización de imágenes o una adaptación del Worker;
- autenticación equivalente a la de Sites;
- política de acceso privada;
- dominio y TLS.

Otra plataforma requerirá adaptar `worker/index.ts`, el acceso a `cloudflare:workers`, D1 y R2. La interfaz React y la mayor parte de los parsers pueden reutilizarse, pero la capa de persistencia no es portable sin cambios.

## Restaurar el historial Git

El paquete se entrega también con un archivo `patrimonio-familiar-history.bundle`. Para recrear un repositorio con todo el historial:

```bash
git clone patrimonio-familiar-history.bundle patrimonio-familiar
cd patrimonio-familiar
git switch main
```

El bundle contiene el historial de código hasta el commit publicado. La especificación y esta guía se entregan además en la carpeta portable.

## Documentos de referencia

- `README.md`: introducción original del repositorio.
- `apps/web/README.md`: comandos y autenticación del módulo productivo.
- `docs/architecture.md`: arquitectura inicial.
- `docs/ESPECIFICACION_PATRIMONIO_FAMILIAR.md`: especificación funcional y técnica completa.
