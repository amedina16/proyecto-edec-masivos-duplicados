# HubSpot Dedup App

Herramienta web para detectar y mergear contactos duplicados en HubSpot,
usando normalización de teléfonos E.164 y login por magic link.

---

## Estructura

```
├── backend/
│   ├── server.js           Servidor Express
│   ├── middleware/auth.js  Verificación JWT
│   └── routes/
│       ├── auth.js         Magic link + JWT
│       ├── audit.js        Descarga y agrupa duplicados
│       └── merge.js        Ejecuta merges en HubSpot API
├── frontend/
│   ├── login.html          Pantalla de acceso
│   └── dashboard.html      Tabla de duplicados + merge
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## Variables de entorno

Copia `.env.example` a `.env` y llena los valores:

| Variable         | Descripción |
|------------------|-------------|
| `APP_URL`        | URL pública de la app (ej. `https://dedup.tudominio.com`) |
| `HUBSPOT_TOKEN`  | Private App Token de HubSpot (necesita permisos de contactos) |
| `JWT_SECRET`     | Secreto para firmar tokens JWT (genera uno aleatorio) |
| `ALLOWED_EMAILS` | Correos autorizados, separados por coma |
| `SMTP_*`         | Configuración de correo para enviar magic links |

Genera un JWT_SECRET seguro:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Despliegue en Dokploy

### 1. Crear la aplicación

En el panel de Dokploy:
- **New Application** → **Docker**
- Source: **Git** (conecta tu repositorio) o **Upload**
- Build: `Dockerfile` (ya está en la raíz)

### 2. Variables de entorno

En la sección **Environment** de tu app en Dokploy, agrega todas las
variables de `.env.example` con sus valores reales.

### 3. Dominio

En la sección **Domains**:
- Agrega tu dominio: `dedup.tudominio.com`
- Activa HTTPS (Dokploy lo gestiona con Let's Encrypt automáticamente)
- Puerto interno: `3000`

### 4. Deploy

Presiona **Deploy**. En 1-2 minutos la app estará disponible.

---

## Desarrollo local

```bash
# Instalar dependencias
npm install

# Copiar y editar variables
cp .env.example .env

# Correr en desarrollo
npm run dev

# O con Docker
docker-compose up --build
```

La app queda en `http://localhost:3000`.

---

## Flujo de uso

1. Ve a `https://dedup.tudominio.com`
2. Ingresa tu email autorizado
3. Haz clic en el enlace que llega al correo (válido 15 min)
4. En el dashboard: **Ejecutar auditoría** (tarda 1-3 min)
5. Revisa la tabla de duplicados. El sistema sugiere el más reciente como principal, pero puedes cambiar la selección
6. Cuando estés listo: **Ejecutar merges** → confirmar
7. La app hace automáticamente una segunda auditoría para confirmar que quedó limpio

---

## Seguridad

- Magic links de un solo uso con TTL de 15 minutos
- JWT con expiración de 8 horas
- Lista blanca de emails en variable de entorno (no hay registro público)
- HUBSPOT_TOKEN solo vive en el servidor, nunca se expone al frontend
- CORS restringido al dominio configurado en APP_URL

---

## Cron semanal (opcional)

Si quieres recibir un reporte automático cada jueves, agrega en Dokploy
un **Cron Job** con:

- Schedule: `0 9 * * 4`  (jueves 9am)
- Command: `node -e "require('./backend/cron/weekly_report.js')"`

O configura un webhook desde cualquier scheduler (Render Cron, Railway, etc.)
apuntando a `POST /api/audit/run` con el header `Authorization: Bearer <tu_jwt>`.
