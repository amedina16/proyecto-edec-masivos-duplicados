const mysql = require("mysql2/promise");

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.DB_HOST     || "localhost",
      port:     parseInt(process.env.DB_PORT || "3306"),
      user:     process.env.DB_USER     || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME     || "hubspot_dedup",
      waitForConnections: true,
      connectionLimit: 10,
      charset: "utf8mb4",
    });
  }
  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

async function initSchema() {
  const db = getPool();
  await db.execute(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || "hubspot_dedup"}\``);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      email      VARCHAR(255) NOT NULL UNIQUE,
      name       VARCHAR(255),
      role       ENUM('admin','dedup','upload') NOT NULL DEFAULT 'dedup',
      status     ENUM('active','inactive') NOT NULL DEFAULT 'active',
      invited_by VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME NULL
    ) CHARACTER SET utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS invitations (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      email      VARCHAR(255) NOT NULL,
      role       ENUM('admin','dedup','upload') NOT NULL DEFAULT 'dedup',
      token      VARCHAR(128) NOT NULL UNIQUE,
      invited_by VARCHAR(255),
      expires_at DATETIME NOT NULL,
      used_at    DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_email VARCHAR(255),
      action     VARCHAR(100) NOT NULL,
      detail     TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user    (user_email),
      INDEX idx_created (created_at)
    ) CHARACTER SET utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS upload_batches (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      name           VARCHAR(255) NOT NULL,
      filename       VARCHAR(255),
      total_rows     INT DEFAULT 0,
      clean_rows     INT DEFAULT 0,
      duplicate_rows INT DEFAULT 0,
      status         ENUM('pending','validating','ready','pushed','error') DEFAULT 'pending',
      created_by     VARCHAR(255),
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      pushed_at      DATETIME NULL
    ) CHARACTER SET utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS field_mappings (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      batch_id    INT NOT NULL,
      csv_column  VARCHAR(255) NOT NULL,
      hs_property VARCHAR(255) NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES upload_batches(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS upload_rows (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      batch_id        INT NOT NULL,
      row_index       INT NOT NULL,
      nombre          VARCHAR(255),
      telefono        VARCHAR(100) NOT NULL,
      telefono_norm   VARCHAR(30),
      email           VARCHAR(255),
      origen          VARCHAR(255),
      campus          VARCHAR(255),
      anio            VARCHAR(10),
      ciclo           VARCHAR(50),
      extra_data      JSON,
      status          ENUM('pending','clean','duplicate','pushed','error','skipped') DEFAULT 'pending',
      duplicate_of_hs VARCHAR(50) NULL,
      duplicate_field VARCHAR(50) NULL,
      hs_contact_id   VARCHAR(50) NULL,
      error_msg       VARCHAR(500) NULL,
      FOREIGN KEY (batch_id) REFERENCES upload_batches(id) ON DELETE CASCADE,
      INDEX idx_batch  (batch_id),
      INDEX idx_status (status),
      INDEX idx_norm   (telefono_norm)
    ) CHARACTER SET utf8mb4
  `);

  // Seed admins
  const ADMINS = (process.env.ADMIN_EMAILS || "contacto@th3roots.com,a.medina@th3roots.com")
    .split(",").map(e => e.trim().toLowerCase()).filter(Boolean);

  for (const email of ADMINS) {
    await db.execute(
      `INSERT INTO users (email, role, status, invited_by)
       VALUES (?, 'admin', 'active', 'system')
       ON DUPLICATE KEY UPDATE role='admin', status='active'`,
      [email]
    );
  }

  console.log("✅  Schema MySQL inicializado");
}

async function logActivity(userEmail, action, detail = "") {
  try {
    await query(
      "INSERT INTO activity_log (user_email, action, detail) VALUES (?, ?, ?)",
      [userEmail, action, detail]
    );
  } catch {}
}

module.exports = { getPool, query, initSchema, logActivity };
