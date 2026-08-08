'use strict';

function entry(key, label, num) {
    return Object.freeze({ key, label, num });
}

function freezeCatalog(entries) {
    return Object.freeze(entries.map((e) => entry(e.key, e.label, e.num)));
}

const INCIDENT_TYPES = freezeCatalog([
    { key: 'first_aid', label: 'First Aid', num: null },
    { key: 'medical_aid_no_lost_time', label: 'Medical Aid – No Lost Time', num: null },
    { key: 'restricted_work', label: 'Restricted Work', num: null },
    { key: 'lost_time', label: 'Lost Time', num: null },
    { key: 'fatality', label: 'Fatality', num: null },
    { key: 'motor_vehicle_incident', label: 'Motor Vehicle Incident', num: null },
    { key: 'contractor_recordable', label: 'Contractor Recordable', num: null },
    { key: 'property_damage', label: 'Property Damage', num: null },
    { key: 'fire_explosion_flood', label: 'Fire/Explosion/Flood', num: null },
    { key: 'violence_or_harassment', label: 'Violence or Harassment', num: null },
    { key: 'near_miss', label: 'Near Miss', num: null },
    { key: 'third_party_incident', label: '3rd Party Incident (e.g. Public)', num: null },
    { key: 'spill_or_release', label: 'Spill or Release', num: null },
    { key: 'work_refusal', label: 'Work Refusal', num: null },
    { key: 'other', label: 'Other', num: null },
]);

const EVENT_TYPES = freezeCatalog([
    { key: 'struck_against', label: 'Struck against', num: null },
    { key: 'struck_by', label: 'Struck by', num: null },
    { key: 'fall_from_elevation', label: 'Fall from elevation', num: null },
    { key: 'fall_on_same_level', label: 'Fall on same level', num: null },
    { key: 'caught_in', label: 'Caught in', num: null },
    { key: 'caught_on', label: 'Caught on', num: null },
    { key: 'caught_between', label: 'Caught between', num: null },
    { key: 'contact_with', label: 'Contact with', num: null },
    { key: 'abnormal_operation', label: 'Abnormal operation', num: null },
    { key: 'product_contamination', label: 'Product contamination', num: null },
    { key: 'overstress_over_exertion_ergonomic', label: 'Overstress, over exertion, ergonomic', num: null },
    { key: 'equipment_failure', label: 'Equipment failure', num: null },
    { key: 'environmental_release', label: 'Environmental release', num: null },
]);

const SUBSTANDARD_ACTS = freezeCatalog([
    { key: 'act_01', label: 'Operating equipment without authority', num: 1 },
    { key: 'act_02', label: 'Failure to warn', num: 2 },
    { key: 'act_03', label: 'Failure to secure/make safe', num: 3 },
    { key: 'act_04', label: 'Operating at improper speed', num: 4 },
    { key: 'act_05', label: 'Making safety devices inoperative', num: 5 },
    { key: 'act_06', label: 'Using defective equipment', num: 6 },
    { key: 'act_07', label: 'Failing to use PPE properly', num: 7 },
    { key: 'act_08', label: 'Improper loading', num: 8 },
    { key: 'act_09', label: 'Improper placement', num: 9 },
    { key: 'act_10', label: 'Improper lifting', num: 10 },
    { key: 'act_11', label: 'Improper position for task', num: 11 },
    { key: 'act_12', label: 'Servicing equipment in operation', num: 12 },
    { key: 'act_13', label: 'Horseplay', num: 13 },
    { key: 'act_14', label: 'Under influence of alcohol and/or drugs', num: 14 },
    { key: 'act_15', label: 'Using equipment improperly', num: 15 },
    { key: 'act_16', label: 'Failure to follow procedure/policy/practice', num: 16 },
    { key: 'act_17', label: 'Failure to identify hazard/risk', num: 17 },
    { key: 'act_18', label: 'Failure to check/monitor', num: 18 },
    { key: 'act_19', label: 'Failure to react/correct', num: 19 },
    { key: 'act_20', label: 'Failure to communicate/coordinate', num: 20 },
]);

const SUBSTANDARD_CONDITIONS = freezeCatalog([
    { key: 'cond_21', label: 'Inadequate guards/barriers', num: 21 },
    { key: 'cond_22', label: 'Inadequate or improper PPE', num: 22 },
    { key: 'cond_23', label: 'Defective tools, equipment or materials', num: 23 },
    { key: 'cond_24', label: 'Congestion or restricted action', num: 24 },
    { key: 'cond_25', label: 'Inadequate warning system', num: 25 },
    { key: 'cond_26', label: 'Fire and explosion hazards', num: 26 },
    { key: 'cond_27', label: 'Poor housekeeping/disorder/clutter', num: 27 },
    { key: 'cond_28', label: 'Noise exposure', num: 28 },
    { key: 'cond_29', label: 'Radiation exposure', num: 29 },
    { key: 'cond_30', label: 'Temperature extremes', num: 30 },
    { key: 'cond_31', label: 'Inadequate or excessive illumination', num: 31 },
    { key: 'cond_32', label: 'Inadequate ventilation', num: 32 },
    { key: 'cond_33', label: 'Presence of harmful materials', num: 33 },
    { key: 'cond_34', label: 'Inadequate instructions/procedures', num: 34 },
    { key: 'cond_35', label: 'Inadequate information/data', num: 35 },
    { key: 'cond_36', label: 'Inadequate preparation/planning', num: 36 },
    { key: 'cond_37', label: 'Inadequate support/assistance', num: 37 },
    { key: 'cond_38', label: 'Inadequate communications', num: 38 },
    { key: 'cond_39', label: 'Road conditions', num: 39 },
    { key: 'cond_40', label: 'Weather conditions', num: 40 },
]);

const ROOT_PERSONAL = freezeCatalog([
    { key: 'root_personal_01', label: 'Inadequate Physical/Physiological Capability', num: 1 },
    { key: 'root_personal_02', label: 'Inadequate Mental/Psychological Capability', num: 2 },
    { key: 'root_personal_03', label: 'Physical or Physiological Stress', num: 3 },
    { key: 'root_personal_04', label: 'Mental or Psychological Stress', num: 4 },
    { key: 'root_personal_05', label: 'Lack of Knowledge', num: 5 },
    { key: 'root_personal_06', label: 'Lack of Skill', num: 6 },
    { key: 'root_personal_07', label: 'Improper Motivation', num: 7 },
    { key: 'root_personal_08', label: 'Abuse or Misuse', num: 8 },
    { key: 'other', label: 'Other', num: null },
]);

const ROOT_JOB = freezeCatalog([
    { key: 'root_job_09', label: 'Inadequate leadership and/or Supervision', num: 9 },
    { key: 'root_job_10', label: 'Inadequate Engineering', num: 10 },
    { key: 'root_job_11', label: 'Inadequate Purchasing', num: 11 },
    { key: 'root_job_12', label: 'Inadequate Maintenance', num: 12 },
    { key: 'root_job_13', label: 'Inadequate Tools and Equipment', num: 13 },
    { key: 'root_job_14', label: 'Inadequate Work Standards', num: 14 },
    { key: 'root_job_15', label: 'Excessive Wear and Tear', num: 15 },
    { key: 'root_job_16', label: 'Inadequate Communications', num: 16 },
    { key: 'other', label: 'Other', num: null },
]);

const CORRECTIVE_AREAS = freezeCatalog([
    { key: 'ca_01', label: 'Leadership and administration', num: 1 },
    { key: 'ca_02', label: 'Leadership training', num: 2 },
    { key: 'ca_03', label: 'Planned inspection and maintenance', num: 3 },
    { key: 'ca_04', label: 'Critical task analysis and procedures', num: 4 },
    { key: 'ca_05', label: 'Incident investigation', num: 5 },
    { key: 'ca_06', label: 'Task observation', num: 6 },
    { key: 'ca_07', label: 'Emergency preparedness', num: 7 },
    { key: 'ca_08', label: 'Rules and work permits', num: 8 },
    { key: 'ca_09', label: 'Incident analysis', num: 9 },
    { key: 'ca_10', label: 'Knowledge and skill training', num: 10 },
    { key: 'ca_11', label: 'Personal protective equipment', num: 11 },
    { key: 'ca_12', label: 'Health and hygiene control', num: 12 },
    { key: 'ca_13', label: 'System evaluation', num: 13 },
    { key: 'ca_14', label: 'Engineering and change management', num: 14 },
    { key: 'ca_15', label: 'Personal communications', num: 15 },
    { key: 'ca_16', label: 'Group communications', num: 16 },
    { key: 'ca_17', label: 'General promotion', num: 17 },
    { key: 'ca_18', label: 'Hiring and placement', num: 18 },
    { key: 'ca_19', label: 'Materials and services management', num: 19 },
    { key: 'ca_20', label: 'Off-the-job safety', num: 20 },
    { key: 'ca_21', label: 'Environmental management', num: 21 },
    { key: 'ca_22', label: 'Quality management', num: 22 },
]);

const SUPPORTING_DOCS = freezeCatalog([
    { key: 'doc_hazard_assessment', label: 'Hazard Assessment', num: null },
    { key: 'doc_incident_report', label: 'Incident Report', num: null },
    { key: 'doc_injury_illness_report', label: 'Injury/Illness Report', num: null },
    { key: 'doc_witness_statements', label: 'Witness Statements', num: null },
    { key: 'doc_sketch_of_incident_scene', label: 'Sketch of incident scene', num: null },
    { key: 'doc_police_report', label: 'Police Report', num: null },
    { key: 'doc_photos', label: 'Photos', num: null },
    { key: 'other', label: 'Other', num: null },
]);

module.exports = {
    INCIDENT_TYPES,
    EVENT_TYPES,
    SUBSTANDARD_ACTS,
    SUBSTANDARD_CONDITIONS,
    ROOT_PERSONAL,
    ROOT_JOB,
    CORRECTIVE_AREAS,
    SUPPORTING_DOCS,
};
