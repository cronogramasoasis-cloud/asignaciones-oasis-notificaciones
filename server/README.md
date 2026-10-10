# Backend de notificaciones de A.S.A.F.

Este backend es independiente de la web publicada en Netlify. Node.js consulta Firestore y envía notificaciones web mediante Firebase Cloud Messaging (FCM). En el despliegue incluido, GitHub Actions ejecuta una revisión automática cada cinco minutos, así que no hace falta mantener un servidor encendido 24/7.

## Eventos automatizados

1. **Solicitudes de suplencia:** avisa a usuarios con `es_operador: true` y tokens push activos.
2. **Asignaciones musicales:** recordatorios individuales el día anterior a las 12:00 y 18:00, y el mismo día a las 08:00. Solo se procesan cuando el mes de horarios está publicado.
3. **Asignaciones de oración por audio:** recordatorios al integrante asignado el día anterior a las 12:00 y 18:00, y el mismo día a las 08:00. Son independientes de las disponibilidades y de la publicación del horario musical.
4. **Ensayos:** recordatorios al equipo del servicio asociado, en las horas configuradas; solo se procesan cuando el mes de horarios está publicado. Si el ensayo no puede asociarse inequívocamente con un servicio, no se envía a un equipo arbitrario.
5. **Canciones actualizadas:** aviso al equipo del servicio, excluyendo a quien hizo el cambio.
6. **Apertura del mes siguiente:** aviso a usuarios con push activo cuando el operador abre disponibilidad para el mes siguiente.
7. **Publicación de horarios:** aviso general a usuarios con token FCM activo cuando el operador hace visible un mes. Las asignaciones musicales y los ensayos dejan de recordarse mientras ese mes esté oculto; las asignaciones de oración se mantienen independientes.

Cada evento utiliza una clave de idempotencia para que una revisión repetida no produzca avisos duplicados. Los envíos se procesan individualmente por destinatario/momento cuando corresponde, los tokens inválidos se limpian y los eventos sin entregas exitosas pueden reintentarse.

## Requisitos

- Node.js 22 o superior; el workflow usa Node.js 24.
- Una cuenta de servicio de Firebase Admin SDK para el proyecto `oasis-asignaciones`.
- Tokens FCM almacenados en `usuarios/{uid}.fcm_tokens`, con `fcm_push_enabled` no desactivado y permiso de notificaciones concedido en el dispositivo.

## Prueba local

```bash
cd server
npm install
cp .env.example .env
```

Guarda una credencial privada de Firebase de forma segura y define `FIREBASE_SERVICE_ACCOUNT_JSON` o `GOOGLE_APPLICATION_CREDENTIALS`. No subas la clave privada a GitHub ni a Netlify.

```bash
npm start
```

Una prueba puntual usa `node server.js --once`. La primera ejecución crea `configuracion/notificaciones_backend` como línea base y omite eventos antiguos para evitar una ráfaga inicial de avisos.

## GitHub Actions

Configura el secreto `FIREBASE_SERVICE_ACCOUNT_JSON` en **Settings → Secrets and variables → Actions**. El workflow de la raíz ejecuta `node server.js --once` cada cinco minutos. Ante un fallo de Firestore/FCM, la ejecución aparece como fallida, en lugar de ocultar el error.
