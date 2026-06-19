(function_declaration name: (identifier) @name) @decl.function
(method_definition name: (property_identifier) @name) @decl.function
(class_declaration name: (type_identifier) @name) @decl.class
(interface_declaration name: (type_identifier) @name) @decl.interface
(type_alias_declaration name: (type_identifier) @name) @decl.type
(enum_declaration name: (identifier) @name) @decl.enum
(lexical_declaration (variable_declarator name: (identifier) @name)) @decl.variable
