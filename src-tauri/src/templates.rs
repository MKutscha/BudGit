//! Vorlagen für neue Haushalte. Enthalten nur Namen, nie Beträge.

use crate::model::{TemplateGroup, TemplateInfo};

pub struct Tpl {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// Standard-Aufteilung der Posten: "income" oder "equal"
    pub split: &'static str,
    pub groups: Vec<(&'static str, Vec<&'static str>)>,
}

pub fn all() -> Vec<Tpl> {
    vec![
        Tpl {
            id: "paar",
            name: "Paar",
            description: "Gemeinsame Wohnung, Alltag, Abos und Versicherungen. Kosten nach Einkommen.",
            split: "income",
            groups: vec![
                ("Wohnen", vec!["Miete", "Nebenkosten", "Strom", "Internet"]),
                ("Alltag", vec!["Lebensmittel", "Haushaltsbedarf", "Drogerie"]),
                ("Abos und Freizeit", vec!["Netflix", "Spotify", "Amazon Prime"]),
                ("Versicherungen und Gebühren", vec!["Haftpflicht", "Hausrat", "Rundfunkbeitrag (GEZ)"]),
            ],
        },
        Tpl {
            id: "wg",
            name: "WG",
            description: "Gemeinsame Kosten einer Wohngemeinschaft. Alles zu gleichen Teilen.",
            split: "equal",
            groups: vec![
                ("Wohnen", vec!["Miete", "Nebenkosten", "Strom", "Internet", "Rundfunkbeitrag (GEZ)"]),
                ("Gemeinschaft", vec!["Putz- und Spülmittel", "Küchenbedarf", "Gemeinsame Einkäufe"]),
                ("Abos", vec!["Netflix", "Spotify"]),
            ],
        },
        Tpl {
            id: "familie",
            name: "Familie",
            description: "Mit Kindern und Mobilität. Kosten nach Einkommen.",
            split: "income",
            groups: vec![
                ("Wohnen", vec!["Miete oder Kreditrate", "Nebenkosten", "Strom", "Internet"]),
                ("Alltag", vec!["Lebensmittel", "Haushaltsbedarf", "Drogerie"]),
                ("Kinder", vec!["Betreuung", "Schule und Material", "Kleidung", "Taschengeld"]),
                ("Mobilität", vec!["Kfz-Versicherung", "Kfz-Steuer", "Sprit", "ÖPNV"]),
                ("Abos und Freizeit", vec!["Netflix", "Spotify", "Vereine und Hobbys"]),
                ("Versicherungen und Gebühren", vec!["Haftpflicht", "Hausrat", "Rundfunkbeitrag (GEZ)"]),
            ],
        },
        Tpl {
            id: "minimal",
            name: "Minimalistisch",
            description: "Nur das Nötigste: Miete, Nebenkosten und Lebensmittel.",
            split: "income",
            groups: vec![
                ("Wohnen", vec!["Miete", "Nebenkosten"]),
                ("Alltag", vec!["Lebensmittel"]),
            ],
        },
        Tpl {
            id: "leer",
            name: "Leer",
            description: "Du legst Gruppen und Posten selbst an.",
            split: "income",
            groups: vec![],
        },
    ]
}

pub fn find(id: &str) -> Option<Tpl> {
    all().into_iter().find(|t| t.id == id)
}

pub fn infos() -> Vec<TemplateInfo> {
    all()
        .into_iter()
        .map(|t| TemplateInfo {
            id: t.id.into(),
            name: t.name.into(),
            description: t.description.into(),
            groups: t
                .groups
                .into_iter()
                .map(|(g, items)| TemplateGroup {
                    name: g.into(),
                    items: items.into_iter().map(String::from).collect(),
                })
                .collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_names_are_not_empty() {
        let t = all();
        for (i, a) in t.iter().enumerate() {
            assert!(!a.name.is_empty() && !a.description.is_empty());
            assert!(["income", "equal"].contains(&a.split));
            assert!(t.iter().skip(i + 1).all(|b| b.id != a.id), "doppelte ID {}", a.id);
            for (g, items) in &a.groups {
                assert!(!g.is_empty() && !items.is_empty());
            }
        }
        assert!(find("leer").is_some() && find("gibt-es-nicht").is_none());
    }
}
