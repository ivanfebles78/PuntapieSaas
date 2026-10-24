// Roles de la aplicación. El Administrador ve y hace todo (incluido lo del
// Empleado); el Asesor (p. ej. la gestoría) lo ve todo pero no cambia nada;
// el Empleado tiene una vista limitada que se irá definiendo módulo a módulo.
export const ROLES = Object.freeze({
  admin: { label: 'Administrador', description: 'Ve y hace todo, incluida la gestión del equipo.' },
  asesor: { label: 'Asesor', description: 'Lo ve todo (también Admin) pero no puede cambiar nada.' },
  empleado: { label: 'Empleado', description: 'Vista limitada al trabajo diario de la tienda.' },
});

/** Roles que solo pueden leer: cualquier petición que no sea de lectura se rechaza. */
export const READ_ONLY_ROLES = Object.freeze(['asesor']);

export const ROLE_IDS = Object.freeze(Object.keys(ROLES));

export function isValidRole(role) {
  return ROLE_IDS.includes(role);
}
