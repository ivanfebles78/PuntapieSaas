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
    summary: 'Facturación, gasto y beneficio de un vistazo.',
    submodules: [
      { slug: 'facturacion', name: 'Facturación', icon: 'moneyIn', summary: 'Ingresos por ventas en tienda y web.' },
      { slug: 'gasto', name: 'Gasto', icon: 'moneyOut', summary: 'Gastos por tipo, proveedor y periodo.' },
      { slug: 'beneficio', name: 'Beneficio', icon: 'coin', summary: 'Lo que queda: ingresos menos gastos.' },
      { slug: 'evolucion', name: 'Evolución', icon: 'calendar', summary: 'Comparativas diarias, semanales y mensuales.' },
    ],
  },
  {
    slug: 'admin',
    name: 'Admin',
    icon: 'shield',
    tone: 'admin',
    roles: ['admin'],
    summary: 'Equipo, accesos y vacaciones.',
    // `to` enlaza con una pantalla ya construida. Todo el equipo se gestiona
    // desde Usuarios: altas, bajas, roles, contraseñas y vacaciones.
    submodules: [
      {
        slug: 'usuarios',
        name: 'Usuarios',
        icon: 'people',
        summary: 'Altas e invitaciones, bajas, roles, contraseñas y vacaciones de cada persona.',
        to: 'usuarios',
      },
    ],
  },
]);

export const ROLE_LABELS = Object.freeze({ admin: 'Administrador', empleado: 'Empleado' });

export function modulesForRole(role) {
  return MODULES.filter((module) => !module.roles || module.roles.includes(role));
}
