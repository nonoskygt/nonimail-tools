'use strict';
// Correos de ejemplo (sintéticos, sin datos reales) con la decisión esperada: promo | keep | duda.
// Los usan scripts/bench-llm.js (medir un modelo) y scripts/demo-imap.js (buzón de prueba).
const P = (from, subject, bulk, body, want) => ({ from, subject, bulk, body, want });
const CASES = [
  P('Ofertas Tienda <promo@tienda.example>', '¡70% OFF solo este fin de semana!', true, 'Aprovecha descuentos en toda la tienda. Compra ahora. Si no quieres recibir más correos, date de baja.', 'promo'),
  P('Netflix <info@mailer.netflix.example>', 'Nuevos estrenos que te van a encantar', true, 'Mira lo nuevo de esta semana en Netflix. Series y películas recomendadas para ti.', 'promo'),
  P('LinkedIn <notifications@linkedin.example>', 'Tienes 5 invitaciones pendientes', true, 'Juan, María y 3 personas más quieren conectar contigo. Ver invitaciones.', 'promo'),
  P('Temu <deals@temu.example>', 'Tu cupón de Q200 expira hoy', true, 'Usa tu cupón antes de medianoche. Envío gratis en tu primer pedido.', 'promo'),
  P('Newsletter Marca <news@marca.example>', 'Novedades de octubre', true, 'Las novedades del mes: productos nuevos, consejos y eventos. Darse de baja.', 'promo'),
  P('Spotify <no-reply@spotify.example>', 'Tu playlist semanal está lista', true, 'Descubrimiento semanal: 30 canciones nuevas elegidas para ti.', 'promo'),
  P('Facebook <notification@facebookmail.example>', 'Ana publicó algo nuevo', true, 'Ana Gómez compartió una foto. Mira lo que tus amigos están haciendo.', 'promo'),
  P('Encuestas <survey@encuesta.example>', '¿Cómo fue tu experiencia? Responde en 2 minutos', true, 'Queremos conocer tu opinión. Participa y gana un premio.', 'promo'),
  P('Amazon <store-news@amazon.example>', 'Ofertas relámpago recomendadas para ti', true, 'Basado en tus compras, te recomendamos estos productos con descuento.', 'promo'),
  P('Udemy <students@udemy.example>', 'Cursos desde $9.99 — solo hoy', true, 'Aprende algo nuevo con los cursos más vendidos. Oferta por tiempo limitado.', 'promo'),
  P('Shein <shein@marketing.example>', 'New arrivals just for you', true, 'Shop the latest trends. Free shipping over $29. Unsubscribe here.', 'promo'),
  P('Booking <deals@booking.example>', 'Ofertas de último minuto en Antigua', true, 'Hoteles con hasta 40% de descuento. Reserva ahora.', 'promo'),
  P('Medium Daily Digest <noreply@medium.example>', 'Stories for you: 10 productivity tips', true, 'Today\'s highlights picked for you. Read more on Medium.', 'promo'),
  P('Webinar Pro <events@webinar.example>', 'Últimos lugares: webinar gratuito de marketing', true, 'Regístrate al evento online. Cupos limitados. Darse de baja.', 'promo'),
  P('Casino Online <vip@casino.example>', 'Bono de bienvenida 200%', true, 'Juega ahora y recibe tu bono. Términos aplican.', 'promo'),
  P('Banco Industrial <alertas@bi.example>', 'Consumo con tu tarjeta por Q350.00', false, 'Se realizó un consumo con tu tarjeta terminada en 4821 en SUPERMERCADO. Si no lo reconoces llama al 1717.', 'keep'),
  P('Google <no-reply@accounts.google.example>', 'Alerta de seguridad: nuevo inicio de sesión', false, 'Se inició sesión en tu cuenta desde un nuevo dispositivo Windows. Si fuiste tú, ignora este mensaje.', 'keep'),
  P('Mi Banco <noreply@banco.example>', 'Tu código de verificación es 482910', false, 'Usa el código 482910 para completar tu operación. No lo compartas con nadie.', 'keep'),
  P('Facturación EEGSA <facturas@eegsa.example>', 'Factura electrónica octubre 2026', false, 'Adjuntamos tu factura del mes. Total a pagar: Q412.50. Vence el 25/10/2026.', 'keep'),
  P('Carlos Pérez <carlos.perez@gmail.example>', 'Re: reunión del jueves', false, 'Hola, confirmo para el jueves a las 10. ¿Llevas tú la propuesta impresa?', 'keep'),
  P('Mamá <mama.lopez@gmail.example>', 'Fotos del cumpleaños', false, 'Te mando las fotos de ayer. Abrazos, nos vemos el domingo.', 'keep'),
  P('Amazon <shipment-tracking@amazon.example>', 'Tu pedido fue enviado', true, 'Tu pedido #112-445 fue enviado y llegará el viernes. Rastrea tu paquete.', 'keep'),
  P('SAT Guatemala <notificaciones@sat.example>', 'Notificación de declaración presentada', false, 'Se recibió tu declaración del IVA del período 09/2026. Número de formulario 2237.', 'keep'),
  P('Clínica Dental <citas@clinica.example>', 'Recordatorio: tu cita es mañana 9:00', false, 'Te esperamos mañana a las 9:00 con la Dra. Ruiz. Responde para confirmar.', 'keep'),
  P('PayPal <service@paypal.example>', 'Recibiste un pago de $120.00', false, 'Recibiste $120.00 USD de Juan Martínez. El dinero ya está en tu cuenta.', 'keep'),
  P('Recursos Humanos <rrhh@miempresa.example>', 'Boleta de pago quincena 2', false, 'Adjunto tu boleta de pago de la segunda quincena de octubre.', 'keep'),
  P('GitHub <noreply@github.example>', '[GitHub] A new SSH key was added to your account', false, 'A new public key was added to your account. If you did not do this, remove it now.', 'keep'),
  P('Uber Receipts <noreply@uber.example>', 'Tu recibo del viaje del martes', true, 'Gracias por viajar. Total: Q48.00. Ver detalles del viaje.', 'keep'),
  P('Profesor Ramírez <jramirez@universidad.example>', 'Entrega del proyecto final', false, 'Recuerden que la entrega es el lunes antes de las 23:59 por la plataforma.', 'keep'),
  P('Aerolínea <checkin@aerolinea.example>', 'Tu pase de abordar para GUA → MIA', false, 'Vuelo 431 sale el 22/10 a las 07:15. Puerta asignada 12. Adjuntamos tu pase.', 'keep'),
  P('Municipalidad <tramites@muni.example>', 'Tu trámite de licencia fue aprobado', false, 'Puedes recoger tu licencia en la ventanilla 3 a partir del lunes.', 'keep'),
  P('Coursera <no-reply@coursera.example>', 'Felicidades, completaste el curso', true, 'Tu certificado ya está disponible. Descárgalo desde tu perfil. Mira otros cursos recomendados.', 'duda'),
  P('Proveedor Nube <billing@nube.example>', 'Tu factura se genera el 1 | Nuevo: GPU con 20% de descuento', true, 'Tu próxima factura se generará el 1 de noviembre. Además, prueba nuestros servidores con GPU.', 'duda'),
  P('ONG Ambiental <editor@ong.example>', 'Boletín: avances de la campaña', true, 'Gracias por tu apoyo. Así avanza la campaña de reforestación este mes.', 'duda'),
  P('Router <no-reply@mirouter.example>', 'Config Created', false, 'A new configuration backup was created on your device.', 'duda'),
  P('Colegio <info@colegio.example>', 'Circular: actividades de la semana', true, 'Estimados padres, compartimos el calendario de actividades y el menú de la cafetería.', 'duda'),
  P('Gym <socios@gym.example>', 'Tu membresía vence en 5 días', true, 'Renueva tu membresía y obtén un mes gratis. Pasa por recepción.', 'duda'),
  P('Steam <noreply@steam.example>', 'Un juego de tu lista de deseados está en oferta', true, 'Cyberpunk está con 50% de descuento hasta el lunes.', 'promo'),
  P('Rappi <promos@rappi.example>', 'Envío gratis en tu próximo pedido 🍔', true, 'Pide ahora y no pagues envío. Válido hasta las 23:59.', 'promo'),
  P('Seguros XYZ <polizas@seguros.example>', 'Renovación de tu póliza de auto', false, 'Tu póliza vence el 30/11. Adjuntamos la propuesta de renovación con la prima actualizada.', 'keep'),
];

module.exports = { CASES };

