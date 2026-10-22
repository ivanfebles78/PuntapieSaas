// Cuentas iniciales del equipo. La contraseña inicial va ya hasheada (bcrypt,
// 12 rondas) y deben cambiarla en su primer acceso. Se crean solo si no
// existen: nunca pisan una cuenta ya creada ni una contraseña ya cambiada.
export const TEAM_SEED = Object.freeze([
  { username: 'ctoriz', name: 'Claudia', role: 'admin', passwordHash: '$2b$12$grf/rumTFpGki9ENg584TuD/2Mg0sqUFlZfrflPGT/iQisYnJ01dO' },
  { username: 'epena', name: 'Elena', role: 'empleado', passwordHash: '$2b$12$66Ip0EdOHBK4kDq3TbpP1.WgCe9T9kPYij0r2rtnVeDqkjZnX0Vje' },
  { username: 'rperez', name: 'Raquel', role: 'empleado', passwordHash: '$2b$12$tMJOs3gsdeDdyPSz3cTWj.fPTRSnoRh8caMtVyrZ5baM8mYTJivBq' },
  { username: 'ifebles', name: 'Iván', role: 'admin', passwordHash: '$2b$12$aVO8tOY5uok7krBl22YpQ.PoWsejI.n8/9MqQbOvf9Eiv7hrui.Oy' },
]);

export async function seedTeam(pool, seed = TEAM_SEED, log = console) {
  for (const member of seed) {
    const result = await pool.query(
      `INSERT INTO users (username, name, role, password_hash, must_change_password)
       SELECT $1, $2, $3, $4, TRUE
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(username) = lower($1))`,
      [member.username, member.name, member.role, member.passwordHash],
    );
    if (result.rowCount > 0) {
      log.info(`[seed] Usuario ${member.username} (${member.role}) creado.`);
      continue;
    }
    // Cuentas creadas antes de conocer su nombre: solo se corrige el nombre
    // provisional (igual al usuario); nunca uno ya editado desde Admin.
    await pool.query(
      'UPDATE users SET name = $2 WHERE lower(username) = lower($1) AND name = username',
      [member.username, member.name],
    );
  }
}
