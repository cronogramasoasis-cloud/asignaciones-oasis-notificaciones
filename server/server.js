require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');
const { DateTime } = require('luxon');
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Caracas';
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'https://cronogramas-oasis.netlify.app/';
const PORT = Number(process.env.PORT || 3000);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '* * * * *';

const DAY_BEFORE_HOUR = Number(process.env.ENSAYO_AVISO_DIA_ANTERIOR_HORA ?? 18);
const DAY_BEFORE_MINUTE = Number(process.env.ENSAYO_AVISO_DIA_ANTERIOR_MINUTO ?? 0);
const SAME_DAY_HOUR = Number(process.env.ENSAYO_AVISO_MISMO_DIA_HORA ?? 8);
const SAME_DAY_MINUTE = Number(process.env.ENSAYO_AVISO_MISMO_DIA_MINUTO ?? 0);

function fail(message) {
  console.error(`[NOTIFICACIONES] ${message}`);
  process.exit(1);
}

function initAdmin() {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      initializeApp({ credential: cert(serviceAccount) });
      console.log('[NOTIFICACIONES] Firebase Admin inicializado con FIREBASE_SERVICE_ACCOUNT_JSON.');
      return;
    }

    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credentialsPath) {
      const absolutePath = path.resolve(process.cwd(), credentialsPath);
      if (!fs.existsSync(absolutePath)) {
        fail(`No existe GOOGLE_APPLICATION_CREDENTIALS: ${absolutePath}`);
      }
      const serviceAccount = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
      initializeApp({ credential: cert(serviceAccount) });
      console.log(`[NOTIFICACIONES] Firebase Admin inicializado con ${absolutePath}.`);
      return;
    }

    initializeApp({ credential: applicationDefault() });
    console.log('[NOTIFICACIONES] Firebase Admin inicializado con Application Default Credentials.');
  } catch (error) {
    fail(`No se pudo inicializar Firebase Admin: ${error.message}`);
  }
}

initAdmin();

const db = getFirestore();
const messaging = getMessaging();

const app = express();
app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'asignaciones-oasis-notificaciones',
    timezone: APP_TIMEZONE,
    cron: CRON_SCHEDULE,
    now: DateTime.now().setZone(APP_TIMEZONE).toISO()
  });
});
app.get('/', (_req, res) => res.status(200).send('Asignaciones Oasis — servidor de notificaciones activo.'));

const server = app.listen(PORT, () => {
  console.log(`[NOTIFICACIONES] Servidor escuchando en puerto ${PORT}.`);
  console.log(`[NOTIFICACIONES] Zona horaria: ${APP_TIMEZONE}.`);
  console.log(`[NOTIFICACIONES] Cron: ${CRON_SCHEDULE}.`);
});

let cronEnCurso = false;

function numeroMesClave(month) {
  return `${month.month}-${month.year}`;
}

function mesSiguienteClave(now) {
  return numeroMesClave(now.plus({ months: 1 }));
}

function mesAnteriorClave(now) {
  return numeroMesClave(now.minus({ months: 1 }));
}

function parseMesAnio(clave) {
  const [mes, anio] = String(clave || '').split('-').map(Number);
  if (!Number.isInteger(mes) || !Number.isInteger(anio) || mes < 1 || mes > 12) return null;
  return { mes, anio };
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === 'object' && Number.isFinite(value.seconds)) {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

function parseHora(hora) {
  const text = String(hora || '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function fechaEnsayo(item) {
  const info = parseMesAnio(item.mes_anio);
  const hora = parseHora(item.hora_ensayo);
  const dia = Number(item.dia_ensayo);
  if (!info || !hora || !Number.isInteger(dia)) return null;
  const dt = DateTime.fromObject({
    year: info.anio,
    month: info.mes,
    day: dia,
    hour: hora.hour,
    minute: hora.minute,
    second: 0,
    millisecond: 0
  }, { zone: APP_TIMEZONE });
  return dt.isValid ? dt : null;
}

function formatoFecha(dt) {
  return dt.setLocale('es').toFormat("cccc d 'de' LLLL");
}

function hashEventKey(eventKey) {
  return crypto.createHash('sha256').update(eventKey).digest('hex');
}

async function reclamarEvento(eventKey, payload) {
  const ref = db.collection('notificaciones_enviadas').doc(hashEventKey(eventKey));
  try {
    await ref.create({
      event_key: eventKey,
      tipo: payload.type || 'oasis',
      fecha_creacion: FieldValue.serverTimestamp()
    });
    return ref;
  } catch (error) {
    // ALREADY_EXISTS en gRPC suele llegar como código 6.
    if (error?.code === 6 || error?.code === 'ALREADY_EXISTS') return null;
    throw error;
  }
}

async function liberarEvento(ref) {
  if (!ref) return;
  try {
    await ref.delete();
  } catch (error) {
    console.warn('[NOTIFICACIONES] No se pudo liberar evento reservado:', error.message);
  }
}

function esTokenInvalido(error) {
  const code = String(error?.code || '').toLowerCase();
  return code.includes('registration-token-not-registered')
    || code.includes('invalid-registration-token')
    || code.includes('unregistered');
}

async function quitarTokensInvalidos(invalidByUser) {
  for (const [uid, tokens] of invalidByUser.entries()) {
    if (!tokens.length) continue;
    try {
      await db.collection('usuarios').doc(uid).update({
        fcm_tokens: FieldValue.arrayRemove(...tokens)
      });
    } catch (error) {
      console.warn(`[NOTIFICACIONES] No se pudieron limpiar tokens de ${uid}: ${error.message}`);
    }
  }
}

async function obtenerDestinatarios(userIds, excluirUid = '') {
  const uniqueIds = [...new Set((userIds || []).filter(Boolean).filter(uid => uid !== excluirUid))];
  if (!uniqueIds.length) return [];

  const refs = uniqueIds.map(uid => db.collection('usuarios').doc(uid));
  const docs = await db.getAll(...refs);
  const destinatarios = [];

  docs.forEach(snapshot => {
    if (!snapshot.exists) return;
    const data = snapshot.data() || {};
    if (data.fcm_push_enabled === false) return;
    const tokens = Array.isArray(data.fcm_tokens) ? data.fcm_tokens.filter(Boolean) : [];
    if (!tokens.length) return;
    destinatarios.push({
      uid: snapshot.id,
      nombre: data.nombre_completo || 'Integrante',
      tokens: [...new Set(tokens)]
    });
  });

  return destinatarios;
}

async function obtenerTodosDestinatarios(filtro) {
  const snap = await db.collection('usuarios').get();
  const destinatarios = [];
  snap.forEach(snapshot => {
    const data = snapshot.data() || {};
    if (filtro && !filtro(data)) return;
    if (data.fcm_push_enabled === false) return;
    const tokens = Array.isArray(data.fcm_tokens) ? data.fcm_tokens.filter(Boolean) : [];
    if (!tokens.length) return;
    destinatarios.push({
      uid: snapshot.id,
      nombre: data.nombre_completo || 'Integrante',
      tokens: [...new Set(tokens)]
    });
  });
  return destinatarios;
}

async function enviarNotificacion(destinatarios, { title, body, type, extra = {} }) {
  if (!destinatarios.length) return { successCount: 0, failureCount: 0, destinatarios: 0 };

  const mensajes = [];
  for (const user of destinatarios) {
    for (const token of user.tokens) {
      mensajes.push({
        token,
        data: {
          title: String(title),
          body: String(body),
          type: String(type),
          url: PUBLIC_APP_URL,
          ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)]))
        }
      });
    }
  }

  let successCount = 0;
  let failureCount = 0;
  const invalidByUser = new Map();

  for (let i = 0; i < mensajes.length; i += 500) {
    const chunk = mensajes.slice(i, i + 500);
    const indexToUser = [];
    let cursor = 0;
    for (const user of destinatarios) {
      for (const token of user.tokens) {
        if (cursor >= i && cursor < i + chunk.length) indexToUser.push({ index: cursor - i, uid: user.uid, token });
        cursor += 1;
      }
    }

    const response = await messaging.sendEach(chunk);
    response.responses.forEach((result, localIndex) => {
      if (result.success) {
        successCount += 1;
        return;
      }
      failureCount += 1;
      const target = indexToUser[localIndex];
      if (target && esTokenInvalido(result.error)) {
        if (!invalidByUser.has(target.uid)) invalidByUser.set(target.uid, []);
        invalidByUser.get(target.uid).push(target.token);
      }
      console.warn('[NOTIFICACIONES] FCM rechazó un token:', result.error?.code || result.error?.message || result.error);
    });
  }

  await quitarTokensInvalidos(invalidByUser);
  return { successCount, failureCount, destinatarios: destinatarios.length };
}

async function obtenerEstadoBackend() {
  const ref = db.collection('configuracion').doc('notificaciones_backend');
  const snap = await ref.get();
  if (!snap.exists) {
    const ahora = FieldValue.serverTimestamp();
    await ref.set({
      inicializado: true,
      inicializado_en: ahora,
      ultima_revision_en: ahora
    }, { merge: true });
    return { inicializado: false, ref };
  }
  return { inicializado: true, ref };
}

async function actualizarUltimaRevision(ref) {
  await ref.set({ ultima_revision_en: FieldValue.serverTimestamp() }, { merge: true });
}

async function enviarEventoUnico(eventKey, notification, destinatarios) {
  const claim = await reclamarEvento(eventKey, notification);
  if (!claim) return false;
  try {
    await enviarNotificacion(destinatarios, notification);
    return true;
  } catch (error) {
    await liberarEvento(claim);
    throw error;
  }
}

async function procesarSuplencias(now, initializedAtMs) {
  const monthKeys = [numeroMesClave(now), mesAnteriorClave(now), mesSiguienteClave(now)];
  const snapshots = await Promise.all(monthKeys.map(key => db.collection('horarios_servicios').where('mes_anio', '==', key).get()));
  let procesadas = 0;

  for (const snap of snapshots) {
    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      const equipo = Array.isArray(data.equipo) ? data.equipo : [];
      const servicio = data.descripcion_servicio || 'Servicio';
      const info = parseMesAnio(data.mes_anio);
      const dia = Number(data.dia);
      if (!info || !Number.isInteger(dia)) continue;
      const fechaServicio = DateTime.fromObject({ year: info.anio, month: info.mes, day: dia }, { zone: APP_TIMEZONE });
      const fechaTexto = fechaServicio.isValid ? formatoFecha(fechaServicio) : `día ${dia}`;

      for (const miembro of equipo) {
        if (!miembro?.suplencia_solicitada || !miembro?.id_usuario) continue;
        const eventoMs = toMillis(miembro.suplencia_solicitada_en);
        if (eventoMs === null || eventoMs <= initializedAtMs) continue;

        const eventKey = `suplencia|${docSnap.id}|${miembro.id_usuario}|${eventoMs}`;
        const destinatarios = await obtenerTodosDestinatarios(dataUsuario => !!dataUsuario.es_operador);
        const sent = await enviarEventoUnico(eventKey, {
          title: '🔄 Solicitud de suplencia',
          body: `${miembro.nombre || 'Un integrante'} solicita suplencia para ${servicio} — ${fechaTexto}.`,
          type: 'solicitud_suplencia',
          extra: { horarioId: docSnap.id }
        }, destinatarios);
        if (sent) procesadas += 1;
      }
    }
  }
  return procesadas;
}

async function procesarCanciones(now, initializedAtMs) {
  const monthKeys = [numeroMesClave(now), mesSiguienteClave(now)];
  const snapshots = await Promise.all(monthKeys.map(key => db.collection('horarios_servicios').where('mes_anio', '==', key).get()));
  const cacheUsuarios = new Map();
  let procesadas = 0;

  async function nombreUsuario(uid) {
    if (!uid) return 'El director/operador';
    if (cacheUsuarios.has(uid)) return cacheUsuarios.get(uid);
    const snap = await db.collection('usuarios').doc(uid).get();
    const nombre = snap.exists ? (snap.data()?.nombre_completo || 'El director/operador') : 'El director/operador';
    cacheUsuarios.set(uid, nombre);
    return nombre;
  }

  for (const snap of snapshots) {
    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      const updatedMs = toMillis(data.canciones_actualizadas_en);
      const actorUid = data.canciones_actualizadas_por || '';
      if (updatedMs === null || updatedMs <= initializedAtMs) continue;
      const equipo = Array.isArray(data.equipo) ? data.equipo : [];
      const ids = equipo.map(m => m?.id_usuario).filter(Boolean);
      if (!ids.length) continue;

      const info = parseMesAnio(data.mes_anio);
      const dia = Number(data.dia);
      const fechaServicio = info && Number.isInteger(dia)
        ? DateTime.fromObject({ year: info.anio, month: info.mes, day: dia }, { zone: APP_TIMEZONE })
        : null;
      const fechaTexto = fechaServicio?.isValid ? formatoFecha(fechaServicio) : `día ${dia}`;
      const actor = await nombreUsuario(actorUid);
      const destinatarios = await obtenerDestinatarios(ids, actorUid);
      const eventKey = `canciones|${docSnap.id}|${updatedMs}`;

      const sent = await enviarEventoUnico(eventKey, {
        title: '🎶 Repertorio actualizado',
        body: `${actor} actualizó las canciones para ${data.descripcion_servicio || 'el servicio'} — ${fechaTexto}.`,
        type: 'canciones_actualizadas',
        extra: { horarioId: docSnap.id }
      }, destinatarios);
      if (sent) procesadas += 1;
    }
  }
  return procesadas;
}

async function procesarEnsayos(now, initializedAtMs) {
  const monthKeys = [numeroMesClave(now), mesSiguienteClave(now)];
  const snapshots = await Promise.all(monthKeys.map(key => db.collection('ensayos_servicios').where('mes_anio', '==', key).get()));
  let procesadas = 0;

  for (const snap of snapshots) {
    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      const ensayoDt = fechaEnsayo(data);
      if (!ensayoDt || ensayoDt < now.minus({ days: 2 }) || ensayoDt > now.plus({ months: 2 })) continue;

      const serviceKey = data.dia_servicio;
      const serviceSnap = await db.collection('horarios_servicios')
        .where('mes_anio', '==', data.mes_anio)
        .where('dia', '==', Number(serviceKey))
        .get();
      if (serviceSnap.empty) continue;

      const horario = serviceSnap.docs[0];
      const horarioData = horario.data() || {};
      const ids = (Array.isArray(horarioData.equipo) ? horarioData.equipo : [])
        .map(m => m?.id_usuario)
        .filter(Boolean);
      if (!ids.length) continue;

      const fechaAvisoDiaAnterior = ensayoDt.minus({ days: 1 });
      const afterOrAt = (hour, minute) => now.hour > hour || (now.hour === hour && now.minute >= minute);
      const dueDayBefore = now.hasSame(fechaAvisoDiaAnterior, 'day')
        && afterOrAt(DAY_BEFORE_HOUR, DAY_BEFORE_MINUTE);
      const dueSameDay = now.hasSame(ensayoDt, 'day')
        && afterOrAt(SAME_DAY_HOUR, SAME_DAY_MINUTE);

      if (!dueDayBefore && !dueSameDay) continue;

      // Nunca se emite un recordatorio cuya fecha calculada quede antes del
      // momento en que el servidor fue inicializado.
      const eventoReferencia = dueDayBefore ? fechaAvisoDiaAnterior : ensayoDt;
      if (eventoReferencia.toMillis() <= initializedAtMs) continue;

      const modo = dueDayBefore ? 'dia_anterior' : 'mismo_dia';
      const eventKey = `ensayo|${data.mes_anio}|${serviceKey}|${data.dia_ensayo}|${data.hora_ensayo}|${modo}`;
      const destinatarios = await obtenerDestinatarios(ids);
      const fechaTexto = formatoFecha(ensayoDt);
      const sent = await enviarEventoUnico(eventKey, {
        title: dueDayBefore ? '🎵 Ensayo mañana' : '🎵 Ensayo hoy',
        body: `${horarioData.descripcion_servicio || data.nombre_servicio || 'Servicio'}: ensayo ${dueDayBefore ? 'mañana' : 'hoy'} ${fechaTexto} a las ${data.hora_ensayo || 'hora pendiente'}.`,
        type: dueDayBefore ? 'aviso_ensayo_dia_anterior' : 'aviso_ensayo_mismo_dia',
        extra: { horarioId: horario.id }
      }, destinatarios);
      if (sent) procesadas += 1;
    }
  }
  return procesadas;
}

async function procesarAperturaMesSiguiente(now, initializedAtMs) {
  const ref = db.collection('configuracion').doc('general');
  const snap = await ref.get();
  if (!snap.exists) return 0;
  const data = snap.data() || {};
  if (!data.siguiente_mes_abierto) return 0;

  const openedMs = toMillis(data.siguiente_mes_abierto_en);
  if (openedMs === null || openedMs <= initializedAtMs) return 0;

  const nextMonth = now.plus({ months: 1 });
  const nextMonthKey = numeroMesClave(nextMonth);
  const eventKey = `disponibilidad_mes_siguiente|${nextMonthKey}|${openedMs}`;
  const destinatarios = await obtenerTodosDestinatarios();
  const sent = await enviarEventoUnico(eventKey, {
    title: '🗓️ Disponibilidades abiertas',
    body: `Ya puedes llenar tu disponibilidad para ${nextMonth.setLocale('es').toFormat("LLLL 'de' yyyy")}.`,
    type: 'disponibilidad_mes_siguiente_abierta',
    extra: { mes_anio: nextMonthKey }
  }, destinatarios);
  return sent ? 1 : 0;
}

async function ejecutarRevision() {
  if (cronEnCurso) return;
  cronEnCurso = true;
  const inicio = DateTime.now().setZone(APP_TIMEZONE);

  try {
    const estado = await obtenerEstadoBackend();
    if (!estado.inicializado) {
      console.log('[NOTIFICACIONES] Primera ejecución: se creó la línea base. No se enviarán eventos antiguos.');
      await actualizarUltimaRevision(estado.ref);
      return;
    }

    const estadoSnap = await estado.ref.get();
    const estadoData = estadoSnap.data() || {};
    const initializedAtMs = toMillis(estadoData.inicializado_en) || 0;

    const [suplencias, canciones, ensayos, aperturaMes] = await Promise.all([
      procesarSuplencias(inicio, initializedAtMs),
      procesarCanciones(inicio, initializedAtMs),
      procesarEnsayos(inicio, initializedAtMs),
      procesarAperturaMesSiguiente(inicio, initializedAtMs)
    ]);

    await actualizarUltimaRevision(estado.ref);
    console.log(`[NOTIFICACIONES] Revisión ${inicio.toFormat('yyyy-LL-dd HH:mm')} | suplencias=${suplencias} canciones=${canciones} ensayos=${ensayos} aperturaMes=${aperturaMes}`);
  } catch (error) {
    console.error('[NOTIFICACIONES] Error durante la revisión:', error);
  } finally {
    cronEnCurso = false;
  }
}

cron.schedule(CRON_SCHEDULE, ejecutarRevision, { timezone: APP_TIMEZONE });

// Revisión de arranque sin bloquear el servidor. La línea base evita emitir
// notificaciones históricas al instalar el backend por primera vez.
ejecutarRevision().catch(error => console.error('[NOTIFICACIONES] Error inicial:', error));

function cierre() {
  console.log('[NOTIFICACIONES] Cerrando servidor...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', cierre);
process.on('SIGINT', cierre);
