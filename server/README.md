# Servidor de notificaciones de Asignaciones Oasis

Este backend es independiente de la interfaz que se publica en Netlify. Ejecuta un proceso Node.js con `node-cron`, consulta Firestore y envía notificaciones web mediante Firebase Cloud Messaging (FCM).

## Eventos automatizados

1. Solicitud de suplencia: solo se notifica a usuarios con `es_operador: true` y notificaciones push activadas.
2. Aviso de ensayo: se notifica al equipo asignado. El aviso del día anterior sale a la hora configurada en `ENSAYO_AVISO_DIA_ANTERIOR_HORA/MINUTO`; el aviso del mismo día sale a la hora configurada en `ENSAYO_AVISO_MISMO_DIA_HORA/MINUTO`.
3. Canciones actualizadas por director/operador: se notifica al equipo del servicio, excluyendo a quien hizo el cambio.
4. Apertura del mes siguiente: se notifica a todos los usuarios con notificaciones push activadas cuando el operador abre la disponibilidad del mes siguiente.

## Requisitos

- Node.js 22 o superior.
- Una cuenta de servicio de Firebase con acceso al proyecto `oasis-asignaciones`.
- La aplicación web ya debe guardar los tokens FCM en `usuarios.fcm_tokens`. El frontend entregado en la carpeta raíz ya realiza ese registro.

## Instalación local

```bash
cd server
npm install
cp .env.example .env
```

Descarga una clave privada JSON de la cuenta de servicio desde Firebase Console y guárdala como `serviceAccountKey.json` dentro de `server/`. El `.gitignore` ya evita que se suba al repositorio.

Luego ejecuta:

```bash
npm start
```

La comprobación de salud queda disponible en `/health`.

## Credenciales en hosting

En un servidor como Render/Railway/Cloud Run es preferible guardar la credencial en variables seguras. Se puede usar `GOOGLE_APPLICATION_CREDENTIALS` apuntando a un archivo montado, o `FIREBASE_SERVICE_ACCOUNT_JSON` con el JSON completo de la cuenta de servicio.

Nunca publiques `serviceAccountKey.json`, `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_SERVICE_ACCOUNT_JSON` ni la clave privada en GitHub o dentro de la carpeta que subes a Netlify.

## Primera ejecución

La primera ejecución crea `configuracion/notificaciones_backend` con una línea base. Así, el backend no manda de golpe notificaciones antiguas que ya existían antes de instalarlo. A partir de esa línea base, cada evento nuevo se procesa automáticamente.

El backend guarda una huella de cada evento en `notificaciones_enviadas`, por lo que una misma solicitud/actualización/recordatorio no se vuelve a mandar en cada minuto del cron.

## Importante sobre Netlify

La carpeta raíz se sigue publicando como sitio estático en Netlify. El servidor de esta carpeta `server/` debe ejecutarse en un servicio que mantenga Node.js activo o que ejecute cron de forma fiable. No subas las credenciales privadas al sitio estático.
