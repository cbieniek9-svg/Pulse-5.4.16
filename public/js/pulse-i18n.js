(function () {
    "use strict";

    const dictionaries = {
        en: {
            offline_banner: "Offline mode",
            blocked: "Blocked",
            on_break: "On break",
            priority_clear: "Priority clear",
            order_incoming: "Order incoming",
            shift_progress: "Shift progress",
            pinboard_title: "Pinboard",
            split_tasks: "Split tasks",
            split_countdowns: "Split countdowns",
            start_break_15: "Start 15 min break",
            start_break_30: "Start 30 min break",
            handover: "Handover",
            hazard_report: "Hazard report",
            emergency_power: "Emergency power",
            display_mode_label: "Display mode",
            text_scale_label: "Text size",
            language_label: "Language",
            achievements_label: "Achievements",
            prism_display_hint: "Prism display prefs stay on this device (no server change).",
            sys_ok: "Sys: OK",
            sys_offline: "Sys: Offline",
            bridge_mode: "Bridge",
            high_contrast_mode: "High contrast",
            dock_glare_mode: "Dock glare",
            text_normal: "Normal",
            text_large: "Large",
            text_xl: "XL",
        },
        fr: {
            offline_banner: "Mode hors ligne",
            blocked: "Bloque",
            on_break: "En pause",
            priority_clear: "Priorite reglee",
            order_incoming: "Commande entrante",
            shift_progress: "Progression du quart",
            pinboard_title: "Tableau d'affichage",
            split_tasks: "Repartir les taches",
            split_countdowns: "Repartir les comptes a rebours",
            start_break_15: "Commencer pause 15 min",
            start_break_30: "Commencer pause 30 min",
            handover: "Passation",
            hazard_report: "Rapport de danger",
            emergency_power: "Alimentation d'urgence",
            display_mode_label: "Mode d'affichage",
            text_scale_label: "Taille du texte",
            language_label: "Langue",
            achievements_label: "Reussites",
            prism_display_hint: "Les prefs Prism restent sur cet appareil (aucun changement serveur).",
            sys_ok: "Sys: OK",
            sys_offline: "Sys: Hors ligne",
            bridge_mode: "Bridge",
            high_contrast_mode: "Contraste eleve",
            dock_glare_mode: "Eblouissement quai",
            text_normal: "Normal",
            text_large: "Grand",
            text_xl: "Tres grand",
        },
        es: {
            offline_banner: "Modo sin conexion",
            blocked: "Bloqueado",
            on_break: "En descanso",
            priority_clear: "Prioridad resuelta",
            order_incoming: "Pedido entrante",
            shift_progress: "Progreso del turno",
            pinboard_title: "Tablero",
            split_tasks: "Dividir tareas",
            split_countdowns: "Dividir cuentas regresivas",
            start_break_15: "Iniciar descanso 15 min",
            start_break_30: "Iniciar descanso 30 min",
            handover: "Traspaso",
            hazard_report: "Reporte de riesgo",
            emergency_power: "Energia de emergencia",
            display_mode_label: "Modo de pantalla",
            text_scale_label: "Tamano del texto",
            language_label: "Idioma",
            achievements_label: "Logros",
            prism_display_hint: "Las preferencias Prism permanecen en este dispositivo (sin cambios en el servidor).",
            sys_ok: "Sys: OK",
            sys_offline: "Sys: Desconectado",
            bridge_mode: "Bridge",
            high_contrast_mode: "Alto contraste",
            dock_glare_mode: "Resplandor muelle",
            text_normal: "Normal",
            text_large: "Grande",
            text_xl: "Extra grande",
        },
    };

    function normalizeLang(lang) {
        const code = String(lang || "en").toLowerCase().split("-")[0];
        return dictionaries[code] ? code : "en";
    }

    function t(key, lang) {
        const code = normalizeLang(lang || document.documentElement.lang || "en");
        return dictionaries[code][key] || dictionaries.en[key] || key;
    }

    function apply(lang) {
        const code = normalizeLang(lang);
        document.documentElement.lang = code;
        document.querySelectorAll("[data-i18n]").forEach((node) => {
            const key = node.getAttribute("data-i18n");
            if (key) node.textContent = t(key, code);
        });
        document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
            const key = node.getAttribute("data-i18n-placeholder");
            if (key) node.setAttribute("placeholder", t(key, code));
        });
        return code;
    }

    window.PulseI18n = {
        dictionaries,
        t,
        apply,
        normalizeLang,
    };
})();
