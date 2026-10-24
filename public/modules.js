// Mapa de módulos y submódulos. `roles` limita quién lo ve; sin `roles`, lo ve
// cualquier usuario con sesión. Los permisos reales se aplicarán también en la API
// cuando cada módulo tenga endpoints.
export const MODULES = Object.freeze([
  {
    slug: 'ventas',
    name: 'Ventas',
    icon: 'shop',
    tone: 'ventas',
    summary: 'Lo que vendemos en la tienda y en la web.',
    submodules: [
      { slug: 'tpv', name: 'TPV', icon: 'cardPos', summary: 'Caja de la tienda: cobros, tickets y cierres de caja.' },
      { slug: 'web', name: 'Web', icon: 'global', summary: 'Pedidos y ventas de la tienda online.' },
    ],
  },
  {
    slug: 'gastos',
    name: 'Gastos',
    icon: 'wallet',
    tone: 'gastos',
    summary: 'Todo lo que sale, en una sola tabla con su tipo de gasto.',
    // Sin submenús: una sola tabla; cada gasto lleva su tipo (con su color).
    view: 'gastos',
    countLabel: 'Una sola tabla',
    submodules: [],
    chips: [
      { name: 'Recurrentes', icon: 'repeat', className: 'cat-chip cat-recurrente' },
      { name: 'Esporádicos', icon: 'flash', className: 'cat-chip cat-esporadico' },
      { name: 'Proveedores', icon: 'truck', className: 'cat-chip cat-proveedor' },
    ],
  },
  {
    slug: 'stock',
    name: 'Stock',
    icon: 'box',
    tone: 'stock',
    summary: 'Inventario y entrada de mercancía leyendo pedidos y facturas en PDF.',
    submodules: [
      { slug: 'inventario', name: 'Inventario', icon: 'archive', summary: 'Existencias por marca, modelo, talla y color.' },
      { slug: 'importar-pedido', name: 'Importar pedido', icon: 'docDown', summary: 'Sube el PDF del pedido y el sistema lo integra en el stock previsto.' },
      { slug: 'importar-factura', name: 'Importar factura', icon: 'receipt', summary: 'Sube la factura en PDF: entrada de stock y pago al proveedor.' },
    ],
  },
  {
    slug: 'estadisticas',
    name: 'Estadísticas',
    icon: 'chart',
    tone: 'estadisticas',
    summary: 'Ventas, objetivos, métodos de pago, clientes y horas fuertes.',
    // Sin submenús: un solo panel.
    view: 'estadisticas',
    countLabel: 'Un solo panel',
    submodules: [],
    chips: [
      { name: 'Ventas y objetivo', icon: 'chart' },
      { name: 'Métodos de pago', icon: 'coin' },
      { name: 'Clientes', icon: 'people' },
      { name: 'Horas y turnos', icon: 'clock' },
    ],
  },
  {
    slug: 'admin',
    name: 'Admin',
    icon: 'shield',
    tone: 'admin',
    roles: ['admin', 'asesor'],
    summary: 'Equipo, turnos, accesos, vacaciones y log de acciones.',
    // `to` enlaza con una pantalla ya construida. Cada persona se gestiona
    // desde Usuarios: altas, bajas, roles, contraseñas, turno y vacaciones.
    submodules: [
      {
        slug: 'usuarios',
        name: 'Usuarios',
        icon: 'people',
        summary: 'Altas, bajas, roles y contraseñas; el turno de cada persona, sus vacaciones y horas bonificadas.',
        to: 'usuarios',
      },
      {
        slug: 'aperturas',
        name: 'Aperturas extra',
        icon: 'calendar',
        summary: 'Sábados por la tarde y domingos que abrimos de forma puntual, y quién los trabaja (+7 h de descanso).',
        to: 'aperturas',
      },
      {
        slug: 'log',
        name: 'Log de acciones',
        icon: 'shield',
        summary: 'Todo lo que se hace en la aplicación: quién, cuándo, qué campo y su valor antes y después.',
        to: 'log',
      },
    ],
  },
]);

export const ROLE_LABELS = Object.freeze({ admin: 'Administrador', asesor: 'Asesor', empleado: 'Empleado' });

/** El Asesor lo ve todo pero no cambia nada. */
export const isReadOnly = (user) => user?.role === 'asesor';

export function modulesForRole(role) {
  return MODULES.filter((module) => !module.roles || module.roles.includes(role));
}
