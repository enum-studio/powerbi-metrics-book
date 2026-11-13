// ruleid: no-sql-built-by-string-formatting-typescript
await pool.query(`select * from ${table}`);

// ruleid: no-sql-built-by-string-formatting-typescript
await client.query(`select * from users where name = '${name}'`);

// ruleid: no-sql-built-by-string-formatting-typescript
await db.execute(sql.raw(`select * from ${table}`));

// ruleid: no-sql-built-by-string-formatting-typescript
await pool.query("select * from " + table);

const built = `select * from ${table}`;
// ruleid: no-sql-built-by-string-formatting-typescript
await pool.query(built);

// ok: no-sql-built-by-string-formatting-typescript
await pool.query("select * from users where name = $1", [name]);

// ok: no-sql-built-by-string-formatting-typescript
await pool.query(`select 1`);

// ok: no-sql-built-by-string-formatting-typescript
await db.execute(sql`select * from users where name = ${name}`);

// ok: no-sql-built-by-string-formatting-typescript
console.log(`loaded ${table}`);
