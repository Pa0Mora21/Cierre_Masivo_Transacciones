/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 * 
 * Grupo Vida - Motor de cierre masivo.
 * - Manual: Toma las filas "Pendiente" que dejó el dashboard en la bitácora.
 * - Programada (nocturna): Si no hay filas pendientes, arma la lista con CONFIG_NOCTURNO.
 */
define(['./GV_LIB_Cierre', 'N/runtime', 'N/format', 'N/log'], (lib, runtime, fmt, log) => {

    const CONFIG_NOCTURNO = {
        tipos: ['WO'],
        diasAntiguedad: 90,
        toleranciaPct: 5,
        max: 500
    };

    const ejecId = () => 'EJE-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

    const getInputData = () => {
        let filas = lib.pendientesLog();

        if (!filas.length && runtime.executionContext === runtime.ContextType.SCHEDULED) {
            const hasta = new Date();
            hasta.setDate(hasta.getDate() - CONFIG_NOCTURNO.diasAntiguedad);

            const cand = lib.listarCandidatos({
                tipos: CONFIG_NOCTURNO.tipos,
                hasta: fmt.format({ value: hasta, type: fmt.Type.DATE }),
                max: CONFIG_NOCTURNO.max
            });

            const ejec = ejecId();

            cand.forEach(c => {
                const ev = lib.evaluar(c.tipo, c.id);
                const pct = ev.ordenado ? (ev.pendiente / ev.ordenado) * 100 : 0;

                if (ev.elegible && pct <= CONFIG_NOCTURNO.toleranciaPct) {
                    const logId = lib.crearLog({
                        ejecucion: ejec,
                        tipo: c.tipo,
                        id: c.id,
                        numero: c.numero,
                        resultado: 'Pendiente',
                        modalidad: 'Programada',
                        pendiente: ev.pendiente
                    });

                    filas.push({
                        logId: logId,
                        id: c.id,
                        tipo: c.tipo,
                        numero: c.numero,
                        ejecucion: ejec
                    });
                }
            });
        }

        log.audit('GV cierre', 'Documentos a procesar: ' + filas.length);
        return filas;
    };

    const map = (ctx) => {
        const f = JSON.parse(ctx.value);
        try {
            lib.actualizarLog(f.logId, lib.cerrar(f.tipo, f.id));
        } catch (e) {
            log.error('GV cierre ' + f.tipo + ' ' + f.numero, e.name + ': ' + e.message);
            try {
                lib.actualizarLog(f.logId, { resultado: 'Error', motivo: e.name + ': ' + e.message });
            } catch (x) {
                /* noop */
            }
        }
    };

    const summarize = (s) => {
        let n = 0;
        s.mapSummary.errors.iterator().each(() => {
            n++;
            return true;
        });
        log.audit('GV cierre resumen', 'Procesadas: ' + s.mapSummary.keys.length + ' | Errores no controlados: ' + n);
    };

    return {
        getInputData,
        map,
        summarize
    };
});
