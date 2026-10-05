# Asignaciones Oasis — Notificaciones gratis con GitHub Actions

## Arquitectura
- Netlify: aplicación web.
- Firebase: Auth, Firestore y FCM.
- GitHub Actions: ejecuta la revisión de Node cada 5 minutos.
- No se necesita un servidor encendido 24/7.

## Archivos para Netlify
Subir solamente estos archivos a Netlify:
- index.html
- style.css
- app.js
- firebase.js
- manifest.json
- sw.js
- logo.png
- logo-fondo.png

NO subir `server/` a Netlify.

## Archivos para GitHub
Subir al repositorio:
- `server/`
- `.github/workflows/notificaciones.yml`

El repositorio recomendado es público porque los runners estándar de GitHub son gratuitos en repositorios públicos.

## Credencial Firebase
Firebase Console → Configuración del proyecto → Cuentas de servicio → Firebase Admin SDK → Generar nueva clave privada.

Guardar el JSON descargado de forma segura. No subirlo al repositorio.

## GitHub Secret
Repositorio → Settings → Secrets and variables → Actions → New repository secret.

Nombre exacto:
`FIREBASE_SERVICE_ACCOUNT_JSON`

Valor:
pegar el JSON completo de la cuenta de servicio.

## Primera prueba
GitHub → Actions → `Notificaciones Oasis` → `Run workflow` → `Run workflow`.

## Prueba de suplencia
1. Usuario A activa notificaciones desde Mi Perfil.
2. Usuario A solicita suplencia.
3. Ejecutar el workflow manualmente.
4. El operador debe recibir la notificación.

## Ensayos
El workflow revisa los ensayos cada 5 minutos. Por defecto:
- día anterior: 18:00
- mismo día: 08:00

## Canciones
Cuando un Director u Operador guarda cambios de repertorio, el horario registra quién hizo el cambio y cuándo. El backend detecta ese cambio y notifica al equipo del servicio.

## Disponibilidad del próximo mes
Cuando el operador abre la disponibilidad del mes siguiente, la aplicación registra `siguiente_mes_abierto_en`. El backend usa esa marca para enviar un aviso único a los usuarios con notificaciones activadas.

## Zona horaria
La configuración actual usa `America/Caracas`. Si la iglesia utiliza otra zona horaria, cambiar `APP_TIMEZONE` en `.github/workflows/notificaciones.yml`.
