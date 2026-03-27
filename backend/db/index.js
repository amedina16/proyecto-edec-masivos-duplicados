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
  const conn = getPool();
  const [rows] = await conn.execute(sql, params);
  return rows;
}

async function initSchema() {
  const db = getPool();

  await db.execute(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || "hubspot_dedup"}\``);

  // Lotes de carga
  await db.execute(`
    CREATE TABLE IF NOT EXISTS upload_batches (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      name          VARCHAR(255) NOT NULL,
      filename      VARCHAR(255),
      total_rows    INT DEFAULT 0,
      clean_rows    INT DEFAULT 0,
      duplicate_rows INT DEFAULT 0,
      status        ENUM('pending','validating','ready','pushed','error') DEFAULT 'pending',
      created_by    VARCHAR(255),
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      pushed_at     DATETIME NULL
    ) CHARACTER SET utf8mb4
  `);

  // Mapeo de columnas del CSV → propiedades HubSpot
  await db.execute(`
    CREATE TABLE IF NOT EXISTS field_mappings (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      batch_id    INT NOT NULL,
      csv_column  VARCHAR(255) NOT NULL,
      hs_property VARCHAR(255) NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES upload_batches(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4
  `);

  // Filas individuales de cada lote
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
      duplicate_of_hs VARCHAR(50) NULL COMMENT 'contact id en HubSpot si es duplicado',
      duplicate_field VARCHAR(50) NULL COMMENT 'campo donde se detectó el duplicado',
      hs_contact_id   VARCHAR(50) NULL COMMENT 'id creado en HubSpot tras el push',
      error_msg       VARCHAR(500) NULL,
      FOREIGN KEY (batch_id) REFERENCES upload_batches(id) ON DELETE CASCADE,
      INDEX idx_batch  (batch_id),
      INDEX idx_status (status),
      INDEX idx_norm   (telefono_norm)
    ) CHARACTER SET utf8mb4
  `);

  console.log("✅  Schema MySQL inicializado");
}

module.exports = { getPool, query, initSchema };
