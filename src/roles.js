// Roles de la aplicación, del más al menos amplio. El Administrador ve y
// hace todo (incluido lo del Empleado); el Empleado tiene una vista limitada
// que se irá definiendo módulo a módulo.
export const ROLES = Object.freeze({
  admin: { label: 'Administrador', description: 'Ve y hace todo, incluida la gestión del equipo.' },
  empleado: { label: 'Empleado', description: 'Vista limitada al trabajo diario de la tienda.' },
});

export const ROLE_IDS = Object.freeze(Object.keys(ROLES));

export function isValidRole(role) {
  return ROLE_IDS.includes(role);
}
