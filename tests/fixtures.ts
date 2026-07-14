/**
 * Test fixtures captured from the live OEFA site (trimmed to two rows).
 * Structure is verbatim — including the quirks the parsers must survive:
 * multi-line cell content, the mojarra.jsfcljs onclick shape, and
 * pagination fragments being bare <tr> lists with no parent table.
 */

/** Fragment of the `<update id="...pgLista">` node returned by the search. */
export const SEARCH_FRAGMENT = `<span id="listarDetalleInfraccionRAAForm:pgLista"><div id="listarDetalleInfraccionRAAForm:dt" class="ui-datatable ui-widget ui-datatable-scrollable"><div class="ui-datatable-scrollable-body" tabindex="-1"><table role="grid" class="grillaFlat"><tbody id="listarDetalleInfraccionRAAForm:dt_data" class="ui-datatable-data ui-widget-content"><tr data-ri="0" class="ui-widget-content ui-datatable-even" role="row"><td role="gridcell"> 1</td><td role="gridcell">891-08-PRODUCE/DIGSECOVI-Dsvs</td><td role="gridcell">Corporación del Mar  S.A.
Austral Group S.A.A. </td><td role="gridcell">Planta Playa Lado Norte Puerto Malabrigo</td><td role="gridcell">Pesquería</td><td role="gridcell">264-2012-OEFA/TFA</td><td role="gridcell">
<script type="text/javascript" src="/repdig/javax.faces.resource/jsf.js.xhtml?ln=javax.faces"></script>
<a href="#" title="" onclick="mojarra.jsfcljs(document.getElementById('listarDetalleInfraccionRAAForm'),{'listarDetalleInfraccionRAAForm:dt:0:j_idt63':'listarDetalleInfraccionRAAForm:dt:0:j_idt63','param_uuid':'153a6d2a-cbed-40ef-b8ef-cd2272b19867'},'');return false"><img src="../images/pdf_descarga.png" alt="" style="border:0;width:25px" /></a></td></tr><tr data-ri="1" class="ui-widget-content ui-datatable-odd" role="row"><td role="gridcell"> 2</td><td role="gridcell">857-2011-PRODUCE/DIGSECOVI-Dsvs</td><td role="gridcell">Consorcio Pacífico Sur S.R.L.</td><td role="gridcell">Planta de Congelado y Harina Residual</td><td role="gridcell">Pesquería</td><td role="gridcell">007-2016-OEFA/TFA-SEPIM</td><td role="gridcell"><a href="#" title="" onclick="mojarra.jsfcljs(document.getElementById('listarDetalleInfraccionRAAForm'),{'listarDetalleInfraccionRAAForm:dt:1:j_idt63':'listarDetalleInfraccionRAAForm:dt:1:j_idt63','param_uuid':'9c8d4d4a-846f-4e41-b047-4dbb8b1d2571'},'');return false"><img src="../images/pdf_descarga.png" alt="" style="border:0;width:25px" /></a></td></tr></tbody></table></div><div class="ui-widget-header ui-datatable-scrollable-footer"><div id="listarDetalleInfraccionRAAForm:dt_paginator_bottom" class="ui-paginator" role="navigation"><span class="ui-paginator-current">Página 1 de 176 (1753 registros)</span></div></div><script id="listarDetalleInfraccionRAAForm:dt_s" type="text/javascript">$(function(){PrimeFaces.cw("DataTable","widget_listarDetalleInfraccionRAAForm_dt",{id:"listarDetalleInfraccionRAAForm:dt",paginator:{id:['listarDetalleInfraccionRAAForm:dt_paginator_bottom'],rows:10,rowCount:1753,page:0,currentPageTemplate:'Página {currentPage} de {totalPages} ({totalRecords} registros)'},scrollable:true});});</script></span>`;

/** Bare <tr> list returned by pagination (dt_skipChildren=true) — no parent table. */
export const PAGE_FRAGMENT = `<tr data-ri="10" class="ui-widget-content ui-datatable-even" role="row"><td role="gridcell"> 11</td><td role="gridcell">657-2011-PRODUCE/DIGSECOVI-Dsvs</td><td role="gridcell">Instituto Tecnológico de la Producción</td><td role="gridcell">Planta CHD</td><td role="gridcell">Pesquería</td><td role="gridcell">236-2013-OEFA/TFA</td><td role="gridcell"><a href="#" title="" onclick="mojarra.jsfcljs(document.getElementById('listarDetalleInfraccionRAAForm'),{'listarDetalleInfraccionRAAForm:dt:10:j_idt63':'listarDetalleInfraccionRAAForm:dt:10:j_idt63','param_uuid':'746821e4-f99f-4e5c-90e2-7e2e2e3731d8'},'');return false"><img src="../images/pdf_descarga.png" alt="" /></a></td></tr><tr data-ri="11" class="ui-widget-content ui-datatable-odd" role="row"><td role="gridcell"> 12</td><td role="gridcell">855-2011-PRODUCE</td><td role="gridcell">Pesquera Exalmar S.A.A.</td><td role="gridcell">Planta de Harina</td><td role="gridcell">Pesquería</td><td role="gridcell"></td><td role="gridcell"></td></tr>`;

/** Minimal partial-response document with an update + ViewState rotation. */
export const PARTIAL_RESPONSE = `<?xml version='1.0' encoding='UTF-8'?>
<partial-response id="j_id1"><changes><update id="listarDetalleInfraccionRAAForm:pgLista"><![CDATA[<span>hello</span>]]></update><update id="j_id1:javax.faces.ViewState:0"><![CDATA[NEW_VIEW_STATE_TOKEN==]]></update></changes></partial-response>`;

/** JSF escapes a literal "]]>" by splitting the CDATA section in two. */
export const PARTIAL_RESPONSE_SPLIT_CDATA = `<?xml version='1.0' encoding='UTF-8'?>
<partial-response id="j_id1"><changes><update id="x"><![CDATA[before]]]]><![CDATA[>after]]></update></changes></partial-response>`;

export const PARTIAL_RESPONSE_ERROR = `<?xml version='1.0' encoding='UTF-8'?>
<partial-response id="j_id1"><error><error-name>class javax.faces.application.ViewExpiredException</error-name><error-message><![CDATA[viewId:/consulta/consultaTfa.xhtml - View /consulta/consultaTfa.xhtml could not be restored.]]></error-message></error></partial-response>`;

export const PARTIAL_RESPONSE_REDIRECT = `<?xml version='1.0' encoding='UTF-8'?>
<partial-response id="j_id1"><redirect url="/repdig/sesionExpirada.xhtml"></redirect></partial-response>`;

// ---------------------------------------------------------------------------
// PJ (RichFaces) fixtures — captured verbatim from the live site.

/**
 * One result's download link, exactly as served: the RichFaces.ajax params
 * object is doubly escaped (`&quot;` entities AND backslash-escaped quotes),
 * with uuid dashes as `-` and date slashes as `\/`.
 */
export const PJ_RESULT_LINK = `<a href="#" id="formBuscador:repeat:0:j_idt491" name="formBuscador:repeat:0:j_idt491" onclick="jsf.util.chain(this,event,&quot;RichFaces.$('panelState').show();&quot;,&quot;RichFaces.ajax(\\&quot;formBuscador:repeat:0:j_idt491\\&quot;,event,{\\&quot;parameters\\&quot;:{\\&quot;uuid\\&quot;:\\&quot;82a1732b\\\\u002Dbee7\\\\u002D40f6\\\\u002D9e61\\\\u002D19db22c3a6be\\&quot;,\\&quot;recurso\\&quot;:\\&quot;Casación\\&quot;,\\&quot;nroexp\\&quot;:\\&quot;001785\\\\u002D2024\\&quot;,\\&quot;palabras\\&quot;:\\&quot;Admisibilidad del recurso de casación\\&quot;,\\&quot;pretensiones\\&quot;:\\&quot;Violación de la libertad sexual Art. 170\\&quot;,\\&quot;normaDI\\&quot;:\\&quot;\\&quot;,\\&quot;tipoResolucion\\&quot;:\\&quot;Ejecutoria Suprema\\&quot;,\\&quot;fechaResolucion\\&quot;:\\&quot;09\\\\\\/07\\\\\\/2026\\&quot;,\\&quot;sala\\&quot;:\\&quot;Sala Penal Permanente\\&quot;,\\&quot;sumilla\\&quot;:\\&quot;En el caso, solo los argumentos.\\&quot;} ,\\&quot;incId\\&quot;:\\&quot;1\\&quot;} )&quot;);return false;" title="Ver"><img src="../imagen/btn-ver-ficha.png" style="border:0" /></a>`;

/** A second result link, distinct index/uuid/recurso (raw uuid uses the
 *  site's `-` dash escaping, so we swap the unescaped hex prefix). */
const PJ_RESULT_LINK_2 = PJ_RESULT_LINK.replaceAll('repeat:0', 'repeat:1')
  .replaceAll('82a1732b', '9c8d4d4a')
  .replace('Casación', 'Apelación');

/** A page fragment carrying two results plus the total-count text. */
export const PJ_RESULTS_PAGE = `<span id="formBuscador:optResultado" class="Titulos">De 9916 resoluciones, se obtuvieron 208341 resultados.</span>
${PJ_RESULT_LINK}
${PJ_RESULT_LINK_2}`;

/** The inicio.xhtml search form (trimmed): hidden fields, a select, the two
 *  search buttons (general + specialized) and the ViewState. */
export const PJ_INICIO_FORM = `<form id="formBuscador" name="formBuscador" method="post" action="/jurisprudenciaweb/faces/page/resultado.xhtml">
<input type="hidden" name="formBuscador" value="formBuscador" />
<input type="hidden" name="javax.faces.ViewState" id="javax.faces.ViewState" value="123:456" />
<input id="formBuscador:txtBusqueda" type="text" name="formBuscador:txtBusqueda" value="" />
<select id="formBuscador:buCorte" name="formBuscador:buCorte"><option value="1" selected="selected">Corte Suprema</option><option value="2">Corte Superior</option></select>
<input type="checkbox" name="formBuscador:buNcpp" />
<a href="#" onclick="jsf.util.chain(this,event,'X','mojarra.jsfcljs(document.getElementById(\\'formBuscador\\'),{\\'formBuscador:j_idt31\\':\\'formBuscador:j_idt31\\',\\'forward\\':\\'buscar\\',\\'busqueda\\':\\'especializada\\',\\'formBuscador:j_idt34\\':\\'21\\'},\\'\\')');return false">Especializada</a>
<a href="#" onclick="jsf.util.chain(this,event,'X','mojarra.jsfcljs(document.getElementById(\\'formBuscador\\'),{\\'formBuscador:j_idt69\\':\\'formBuscador:j_idt69\\',\\'forward\\':\\'buscar\\',\\'formBuscador:j_idt71\\':\\'21\\',\\'formBuscador:j_idt72\\':\\'DESC\\'},\\'\\')');return false">General</a>
<input id="formBuscador:spinner" name="formBuscador:spinner" size="10" type="text" value="1" />
<input type="submit" name="formBuscador:j_idt447" value="IR" />
</form>`;
