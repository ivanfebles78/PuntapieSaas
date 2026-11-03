// Avisos del correo que se resuelven solos al hacer el trabajo a mano.

/** Al guardar a mano un PDF que vino por correo (mismo archivo), su aviso queda resuelto. */
export async function resolverPorArchivo(db, { sha256, docId }) {
  if (!sha256) return;
  await db.query(
    "UPDATE mail_attachments SET state = 'hecho', doc_id = $2, resolved_at = NOW(), data = NULL WHERE sha256 = $1 AND state = 'revisar'",
    [sha256, docId],
  );
}

/** Al dar de alta los productos de una factura llegada por correo, su aviso queda resuelto. */
export async function resolverProductos(db, docId) {
  await db.query("UPDATE mail_attachments SET state = 'hecho', resolved_at = NOW() WHERE doc_id = $1 AND state = 'productos'", [docId]);
}
